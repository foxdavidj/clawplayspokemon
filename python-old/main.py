#!/usr/bin/env python3
"""
Main orchestrator for the Claw Plays Pokemon emulator.

Responsibilities:
- Initialize and run the PyBoy emulator
- Poll the Elysia API for vote results
- Execute winning button presses
- Update screenshots for the API to serve
- Manage save state persistence
- Create stream composite (local preview or Twitch)
"""

import asyncio
import os
import signal
import sys
import time
from pathlib import Path
from typing import Optional

import aiohttp
from dotenv import load_dotenv

from emulator import Emulator
from compositor import (
    StreamCompositor,
    StreamState,
    VoteTally,
    LocalPreviewOutput,
    RTMPStreamer,
)


# Load environment variables from .env file
# (Bun auto-loads, but Python needs explicit loading)
load_dotenv()


# Configuration from environment
ROM_PATH = os.getenv("ROM_PATH", "./roms/pokemon_blue.gb")
SCREENSHOT_PATH = os.getenv("SCREENSHOT_PATH", "./data/screenshot.png")
SAVE_STATE_PATH = os.getenv("SAVE_STATE_PATH", "./data/pokemon.save")
API_URL = os.getenv("API_URL", "http://localhost:3000")
INTERNAL_API_KEY = os.getenv("INTERNAL_API_KEY", "changeme")
LOCAL_PREVIEW = os.getenv("LOCAL_PREVIEW", "false").lower() in ("true", "1", "yes")
LOCAL_PREVIEW_PATH = os.getenv("LOCAL_PREVIEW_PATH", "./data/preview.png")
# RTMP URL for streaming - use local mediamtx for testing, Twitch for production
# Local: rtmp://localhost:1935/live/clawplayspokemon
# Twitch: rtmp://live.twitch.tv/app/YOUR_STREAM_KEY
RTMP_URL = os.getenv("RTMP_URL", "")

# Audio volume boost (Game Boy audio is quiet, 5-10 recommended)
AUDIO_VOLUME_BOOST = float(os.getenv("AUDIO_VOLUME_BOOST", "5.0"))

# Save state interval in seconds (saving causes brief audio pause)
SAVE_STATE_INTERVAL = float(os.getenv("SAVE_STATE_INTERVAL", "300.0"))  # 5 minutes

# Timing constants
EMULATOR_FPS = 60
SCREENSHOT_UPDATE_INTERVAL = 0.1  # 10 Hz
VOTE_POLL_INTERVAL = 0.5  # 500ms
STREAM_FPS = 30
GAMESTATE_PUSH_INTERVAL = 5.0  # Push game state every 5 seconds


class ClawPlaysPokemon:
    """Main orchestrator for the Claw Plays Pokemon emulator system."""

    def __init__(self):
        """Initialize all components."""
        self.running = False

        # Validate ROM exists before initializing
        rom_path = Path(ROM_PATH).resolve()
        if not rom_path.exists():
            print(f"ERROR: ROM not found at {rom_path}")
            print("Please place your Pokemon ROM at the configured ROM_PATH")
            sys.exit(1)

        # Initialize emulator
        print(f"Initializing emulator...")
        print(f"  ROM: {ROM_PATH}")
        print(f"  Save state: {SAVE_STATE_PATH}")
        print(f"  Screenshot: {SCREENSHOT_PATH}")
        print(f"  API URL: {API_URL}")
        print(f"  Local preview: {LOCAL_PREVIEW}")

        self.emulator = Emulator(
            rom_path=ROM_PATH,
            save_state_path=SAVE_STATE_PATH,
            screenshot_path=SCREENSHOT_PATH
        )

        # Initialize compositor
        self.compositor = StreamCompositor()

        # Initialize output mode
        # Priority: RTMP_URL > LOCAL_PREVIEW (file)
        self.rtmp_streamer = None
        self.output = None

        if RTMP_URL:
            print(f"  Output: RTMP stream -> {RTMP_URL}")
            self.rtmp_streamer = RTMPStreamer(RTMP_URL, self.compositor)
        elif LOCAL_PREVIEW:
            print(f"  Output: File preview ({LOCAL_PREVIEW_PATH})")
            self.output = LocalPreviewOutput(LOCAL_PREVIEW_PATH, self.compositor)
        else:
            print("  Output: File preview (default)")
            self.output = LocalPreviewOutput(LOCAL_PREVIEW_PATH, self.compositor)

        # State tracking
        self.last_window_id: Optional[int] = None
        self.last_winner: Optional[str] = None
        self.last_winner_votes: int = 0
        self.current_tallies: list[VoteTally] = []
        self.recent_voters: list[tuple[str, str]] = []
        self.time_remaining: int = 10

        # Post-move screenshot tracking
        self._post_move_screenshot_frames: int = 0

        # HTTP session (created in async context)
        self.session: Optional[aiohttp.ClientSession] = None

    async def fetch_status(self) -> Optional[dict]:
        """
        Fetch current voting status from the API.

        Returns:
            Status dict or None if request failed
        """
        if not self.session:
            return None

        try:
            async with self.session.get(
                f"{API_URL}/status",
                headers={"Authorization": f"Bearer {INTERNAL_API_KEY}"},
                timeout=aiohttp.ClientTimeout(total=2)
            ) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    print(f"WARNING: /status returned {resp.status}")
                    return None
        except asyncio.TimeoutError:
            print("WARNING: /status request timed out")
            return None
        except aiohttp.ClientError as e:
            print(f"WARNING: Failed to fetch /status: {e}")
            return None

    async def fetch_voters(self) -> list[tuple[str, str]]:
        """
        Fetch recent voters from the API.

        Returns:
            List of (name, button) tuples
        """
        if not self.session:
            return []

        try:
            async with self.session.get(
                f"{API_URL}/voters",
                timeout=aiohttp.ClientTimeout(total=2)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return [
                        (v["agentName"], v["button"])
                        for v in data.get("recentVoters", [])
                    ]
                return []
        except Exception:
            return []

    async def push_game_state(self) -> bool:
        """
        Push current game state to the API.

        Returns:
            True if successful, False otherwise
        """
        if not self.session:
            return False

        try:
            game_state = self.emulator.get_game_state()
            async with self.session.post(
                f"{API_URL}/internal/gamestate",
                json=game_state,
                headers={"Authorization": f"Bearer {INTERNAL_API_KEY}"},
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                if resp.status == 200:
                    return True
                else:
                    print(f"WARNING: Failed to push game state: {resp.status}")
                    return False
        except Exception as e:
            print(f"WARNING: Failed to push game state: {e}")
            return False

    def update_state_from_api(self, status: dict) -> None:
        """
        Update internal state from API status response.

        Args:
            status: Response from /status endpoint
        """
        current = status.get("currentWindow", {})

        # Update tallies
        self.current_tallies = [
            VoteTally(
                button=t["button"],
                count=t["count"],
                percentage=t["percentage"],
                voters=t.get("voters", [])
            )
            for t in current.get("allTallies", [])
        ]

        # Update time remaining
        self.time_remaining = current.get("timeRemainingSeconds", 10)

        # Check for new result
        prev = status.get("previousResult")
        if prev:
            window_id = prev.get("windowId")
            if window_id != self.last_window_id:
                # New window executed!
                self.last_window_id = window_id

                winner = prev.get("winner")
                if winner:
                    self.last_winner = winner
                    self.last_winner_votes = prev.get("totalVotes", 0)

                    # Execute the button press
                    print(f"Executing: {winner} ({self.last_winner_votes} votes)")
                    self.emulator.press_button(winner)
                    # Schedule screenshot after button release + game reaction time
                    # Button held for 8 frames, plus 12 more for game to update = 20 frames (~333ms)
                    self._post_move_screenshot_frames = 20
                else:
                    print(f"Window {window_id} ended with no votes")

    def build_stream_state(self) -> StreamState:
        """
        Build the current stream state for rendering.

        Returns:
            StreamState for the compositor
        """
        return StreamState(
            game_frame=self.emulator.get_screen_image(),
            time_remaining=self.time_remaining,
            tallies=self.current_tallies,
            recent_voters=self.recent_voters,
            last_winner=self.last_winner,
            last_winner_votes=self.last_winner_votes
        )

    async def emulator_loop(self) -> None:
        """
        Main emulator tick loop.

        Runs at EMULATOR_FPS (60 FPS).
        """
        frame_interval = 1.0 / EMULATOR_FPS
        last_screenshot_time = 0.0
        last_auto_save_time = time.time()

        while self.running:
            loop_start = time.time()

            # Tick the emulator and get audio samples
            audio_samples = self.emulator.tick()

            # Send audio to RTMP stream (buffered for consistent output)
            if self.rtmp_streamer and self.rtmp_streamer.running:
                self.rtmp_streamer.send_audio(audio_samples, volume_boost=AUDIO_VOLUME_BOOST)

            # Update screenshot periodically
            if loop_start - last_screenshot_time >= SCREENSHOT_UPDATE_INTERVAL:
                self.emulator.save_screenshot()
                last_screenshot_time = loop_start

            # Take screenshot after move execution (countdown from button press)
            if self._post_move_screenshot_frames > 0:
                self._post_move_screenshot_frames -= 1
                if self._post_move_screenshot_frames == 0:
                    self.emulator.save_screenshot()
                    last_screenshot_time = loop_start  # Reset periodic timer

            # Auto-save periodically
            if loop_start - last_auto_save_time >= SAVE_STATE_INTERVAL:
                print("Auto-saving...")
                self.emulator.save_state()
                last_auto_save_time = loop_start

            # Maintain frame rate
            elapsed = time.time() - loop_start
            if elapsed < frame_interval:
                await asyncio.sleep(frame_interval - elapsed)

    async def vote_poll_loop(self) -> None:
        """
        Poll the API for vote status.

        Runs at VOTE_POLL_INTERVAL (500ms).
        """
        while self.running:
            # Fetch status
            status = await self.fetch_status()
            if status:
                self.update_state_from_api(status)

            # Also fetch voters (less critical, ok if it fails)
            self.recent_voters = await self.fetch_voters()

            await asyncio.sleep(VOTE_POLL_INTERVAL)

    async def gamestate_push_loop(self) -> None:
        """
        Push game state to the API periodically.

        Runs every GAMESTATE_PUSH_INTERVAL seconds.
        """
        while self.running:
            success = await self.push_game_state()
            if success:
                print("Game state pushed to API")
            await asyncio.sleep(GAMESTATE_PUSH_INTERVAL)

    async def stream_loop(self) -> None:
        """
        Stream/preview output loop.

        Runs at STREAM_FPS (30 FPS).
        """
        frame_interval = 1.0 / STREAM_FPS

        while self.running:
            loop_start = time.time()

            # Build current state and render
            state = self.build_stream_state()

            if self.rtmp_streamer and self.rtmp_streamer.running:
                # RTMP streaming mode (local or Twitch)
                self.rtmp_streamer.send_frame(state)
            elif self.output:
                # File-based preview mode
                self.output.send_frame(state)

            # Maintain frame rate
            elapsed = time.time() - loop_start
            if elapsed < frame_interval:
                await asyncio.sleep(frame_interval - elapsed)

    async def run(self) -> None:
        """
        Start all async loops and run until stopped.
        """
        self.running = True

        # Create HTTP session
        self.session = aiohttp.ClientSession()

        # Start RTMP streaming if configured
        if self.rtmp_streamer:
            if not self.rtmp_streamer.start():
                print("WARNING: Failed to start RTMP stream, falling back to file preview")
                self.rtmp_streamer = None
                self.output = LocalPreviewOutput(LOCAL_PREVIEW_PATH, self.compositor)

        print("\nStarting Claw Plays Pokemon emulator...")
        print("Press Ctrl+C to stop\n")

        try:
            # Run all loops concurrently
            await asyncio.gather(
                self.emulator_loop(),
                self.vote_poll_loop(),
                self.stream_loop(),
                self.gamestate_push_loop()
            )
        except asyncio.CancelledError:
            pass
        finally:
            await self.shutdown()

    async def shutdown(self) -> None:
        """Clean shutdown of all components."""
        print("\nShutting down...")
        self.running = False

        # Close HTTP session
        if self.session:
            await self.session.close()

        # Stop RTMP stream
        if self.rtmp_streamer:
            self.rtmp_streamer.stop()

        # Stop emulator (saves final state)
        self.emulator.stop()

        print("Shutdown complete")


def main() -> None:
    """Entry point for the emulator."""
    print("=" * 50)
    print("Claw Plays Pokemon Emulator")
    print("=" * 50)
    print()

    # Create orchestrator
    clawplayspokemon = ClawPlaysPokemon()

    # Handle graceful shutdown on Ctrl+C
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def signal_handler(sig, frame):
        print("\nReceived shutdown signal...")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    try:
        loop.run_until_complete(clawplayspokemon.run())
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()


if __name__ == "__main__":
    main()
