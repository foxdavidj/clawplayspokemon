#!/usr/bin/env python3
"""
Stream compositor for Claw Plays Pokemon.

Renders a voting overlay sidebar and composites it with the game video stream
using FFmpeg. Outputs to Twitch or another RTMP destination.

Architecture:
    [emulator RTMP] --> [FFmpeg] --> [Twitch RTMP]
                            ^
                            | overlay via named pipe
                            |
    [API /status] --> [This script] --> [/tmp/overlay_pipe]
"""

import io
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import requests
from PIL import Image, ImageDraw, ImageFont


# =============================================================================
# Configuration
# =============================================================================

@dataclass
class Config:
    """Configuration from environment variables."""
    api_url: str = os.environ.get("API_URL", "http://api:3000")
    input_rtmp_url: str = os.environ.get("INPUT_RTMP_URL", "rtmp://rtmp:1935/live/stream")
    output_rtmp_url: str = os.environ.get("OUTPUT_RTMP_URL", "")
    status_poll_interval_ms: int = int(os.environ.get("STATUS_POLL_INTERVAL_MS", "500"))

    # Layout constants (1280x720 output)
    output_width: int = 1280
    output_height: int = 720
    game_width: int = 900      # GBA 240x160 scaled 3.75x
    game_height: int = 600
    game_x: int = 0
    game_y: int = 60           # 60px top padding
    sidebar_x: int = 900
    sidebar_width: int = 380

    # Named pipe for overlay frames
    overlay_pipe_path: str = "/tmp/overlay_pipe"

    # Overlay framerate (frames per second)
    # Must match -framerate in FFmpeg command
    # Higher = less buffering lag, but more CPU
    overlay_fps: int = 15


config = Config()


# =============================================================================
# Colors (dark theme from python-old/compositor.py)
# =============================================================================

class Colors:
    BG = (18, 18, 24)              # Dark purple-gray (for padding areas)
    SIDEBAR_BG = (28, 28, 38)      # Slightly lighter
    ACCENT = (139, 92, 246)        # Purple
    ACCENT_BRIGHT = (167, 139, 250)
    TEXT_PRIMARY = (255, 255, 255)
    TEXT_SECONDARY = (156, 163, 175)
    BAR_BG = (55, 65, 81)
    SUCCESS = (34, 197, 94)        # Green


# =============================================================================
# Button symbols
# =============================================================================

BUTTON_SYMBOLS = {
    "up": "UP",
    "down": "DOWN",
    "left": "LEFT",
    "right": "RIGHT",
    "a": "A",
    "b": "B",
    "start": "START",
    "select": "SELECT",
    "l": "L",
    "r": "R",
}


# =============================================================================
# Overlay Renderer
# =============================================================================

class OverlayRenderer:
    """Renders the sidebar overlay as a transparent PNG."""

    # Font paths to try (in order of preference)
    FONT_PATHS = [
        "./assets/fonts/PressStart2P-Regular.ttf",
        "/app/assets/fonts/PressStart2P-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]

    def __init__(self):
        self.font_path = self._find_font()
        self._load_fonts()
        print(f"Using font: {self.font_path or 'PIL default'}")

    def _find_font(self) -> Optional[str]:
        """Find an available font file."""
        for path in self.FONT_PATHS:
            if Path(path).exists():
                return path
        return None

    def _load_fonts(self) -> None:
        """Load fonts at various sizes."""
        if self.font_path:
            try:
                self.font_large = ImageFont.truetype(self.font_path, 20)
                self.font_medium = ImageFont.truetype(self.font_path, 14)
                self.font_small = ImageFont.truetype(self.font_path, 11)
                self.font_tiny = ImageFont.truetype(self.font_path, 9)
                return
            except Exception as e:
                print(f"WARNING: Failed to load font: {e}")

        # Fallback to default
        self.font_large = ImageFont.load_default()
        self.font_medium = ImageFont.load_default()
        self.font_small = ImageFont.load_default()
        self.font_tiny = ImageFont.load_default()

    def render(self, status: Optional[dict]) -> Image.Image:
        """
        Render the overlay as a transparent RGBA image.

        Only the sidebar area is drawn; the game area is transparent
        so FFmpeg can composite it over the scaled game video.
        """
        # Create transparent canvas (RGBA for alpha channel)
        canvas = Image.new("RGBA", (config.output_width, config.output_height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)

        # Draw sidebar background
        draw.rectangle(
            [(config.sidebar_x, 0), (config.output_width, config.output_height)],
            fill=Colors.SIDEBAR_BG + (255,)  # Add alpha
        )

        if not status:
            # No data yet - show loading state
            draw.text(
                (config.sidebar_x + 20, 60),
                "Loading...",
                font=self.font_medium,
                fill=Colors.TEXT_SECONDARY
            )
            return canvas

        voting = status.get("voting", {})
        self._render_sidebar(draw, voting)

        return canvas

    def _render_sidebar(self, draw: ImageDraw.Draw, voting: dict) -> None:
        """Render the sidebar content."""
        y = 20
        pad_x = config.sidebar_x + 20
        right_x = config.output_width - 20

        # Check if in cooldown
        cooldown = voting.get("cooldown")
        in_cooldown = cooldown and cooldown.get("active", False)

        # Title
        draw.text(
            (pad_x, y),
            "VOTES",
            font=self.font_large,
            fill=Colors.ACCENT
        )

        # Timer or "Waiting..."
        if in_cooldown:
            timer_text = "Waiting..."
            timer_color = Colors.TEXT_SECONDARY
        else:
            time_remaining = voting.get("timeRemainingSeconds", 0)
            timer_text = f"{time_remaining}s"
            timer_color = Colors.TEXT_PRIMARY

        timer_bbox = draw.textbbox((0, 0), timer_text, font=self.font_large)
        timer_width = timer_bbox[2] - timer_bbox[0]
        draw.text(
            (right_x - timer_width, y),
            timer_text,
            font=self.font_large,
            fill=timer_color
        )
        y += 40

        # Divider
        draw.line([(pad_x, y), (right_x, y)], fill=Colors.BAR_BG, width=2)
        y += 15

        # Vote tallies with progress bars
        tallies = voting.get("tallies", [])
        max_bar_width = 160
        bar_x = config.sidebar_x + 80

        for tally in tallies[:6]:  # Show top 6
            button = tally.get("button", "")
            count = tally.get("count", 0)
            percentage = tally.get("percentage", 0)

            if count == 0:
                continue

            symbol = BUTTON_SYMBOLS.get(button, button.upper())

            # Button name
            draw.text(
                (pad_x, y),
                symbol,
                font=self.font_small,
                fill=Colors.TEXT_PRIMARY
            )

            # Background bar
            draw.rectangle(
                [(bar_x, y + 2), (bar_x + max_bar_width, y + 18)],
                fill=Colors.BAR_BG
            )

            # Filled portion
            bar_width = int((percentage / 100) * max_bar_width)
            if bar_width > 0:
                draw.rectangle(
                    [(bar_x, y + 2), (bar_x + bar_width, y + 18)],
                    fill=Colors.ACCENT
                )

            # Count
            count_text = str(count)
            draw.text(
                (bar_x + max_bar_width + 10, y + 2),
                count_text,
                font=self.font_small,
                fill=Colors.TEXT_SECONDARY
            )

            y += 26

        y += 10

        # Divider
        draw.line([(pad_x, y), (right_x, y)], fill=Colors.BAR_BG, width=2)
        y += 15

        # Section: Recent Voters
        draw.text(
            (pad_x, y),
            "RECENT VOTERS",
            font=self.font_small,
            fill=Colors.TEXT_SECONDARY
        )
        y += 22

        recent_voters = voting.get("recentVoters", [])
        for voter in recent_voters[:8]:  # Last 8 voters
            name = voter.get("name", "")
            button = voter.get("button", "")
            symbol = BUTTON_SYMBOLS.get(button, button.upper())

            # Truncate long names
            display_name = name[:20] + "..." if len(name) > 20 else name
            voter_text = f"{display_name} -> {symbol}"

            draw.text(
                (pad_x + 5, y),
                voter_text,
                font=self.font_tiny,
                fill=Colors.TEXT_SECONDARY
            )
            y += 18

        y += 10

        # Divider
        draw.line([(pad_x, y), (right_x, y)], fill=Colors.BAR_BG, width=2)
        y += 12

        # Last action
        last_result = voting.get("lastResult")
        if last_result and last_result.get("winner"):
            winner = last_result["winner"]
            total_votes = last_result.get("totalVotes", 0)
            symbol = BUTTON_SYMBOLS.get(winner, winner.upper())
            last_text = f"LAST: {symbol} ({total_votes} votes)"
            draw.text(
                (pad_x, y),
                last_text,
                font=self.font_small,
                fill=Colors.SUCCESS
            )


# =============================================================================
# API Client
# =============================================================================

class APIClient:
    """Polls the API /status endpoint."""

    def __init__(self):
        self.current_status: Optional[dict] = None
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        """Start the polling thread."""
        self._running = True
        self._thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the polling thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)

    def get_status(self) -> Optional[dict]:
        """Get the latest status (thread-safe)."""
        with self._lock:
            return self.current_status

    def _poll_loop(self) -> None:
        """Background polling loop."""
        url = f"{config.api_url}/status"
        interval = config.status_poll_interval_ms / 1000.0

        while self._running:
            try:
                response = requests.get(url, timeout=2)
                if response.ok:
                    with self._lock:
                        self.current_status = response.json()
            except requests.RequestException as e:
                print(f"Failed to fetch /status: {e}")
            except Exception as e:
                print(f"Unexpected error fetching /status: {e}")

            time.sleep(interval)


# =============================================================================
# Overlay Pipe Writer
# =============================================================================

class OverlayPipeWriter:
    """Writes overlay PNG frames to a named pipe for FFmpeg."""

    def __init__(self, renderer: OverlayRenderer, api_client: APIClient):
        self.renderer = renderer
        self.api_client = api_client
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._pipe_ready = threading.Event()

    def start(self) -> None:
        """Start the pipe writer thread."""
        self._running = True
        self._thread = threading.Thread(target=self._write_loop, daemon=True)
        self._thread.start()

    def wait_for_pipe_ready(self, timeout: float = 30) -> bool:
        """Wait until the pipe is open and ready."""
        return self._pipe_ready.wait(timeout=timeout)

    def stop(self) -> None:
        """Stop the pipe writer thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)

    def _write_loop(self) -> None:
        """Write PNG frames to the named pipe at the configured framerate."""
        frame_interval = 1.0 / config.overlay_fps

        print(f"Opening overlay pipe: {config.overlay_pipe_path}")
        print(f"  (This will block until FFmpeg connects...)")

        try:
            with open(config.overlay_pipe_path, "wb") as pipe:
                print("Overlay pipe connected!")
                self._pipe_ready.set()

                while self._running:
                    frame_start = time.monotonic()

                    # Render current overlay
                    status = self.api_client.get_status()
                    overlay = self.renderer.render(status)

                    # Write as PNG to pipe
                    buf = io.BytesIO()
                    overlay.save(buf, format="PNG")
                    pipe.write(buf.getvalue())
                    pipe.flush()

                    # Sleep to maintain framerate
                    elapsed = time.monotonic() - frame_start
                    sleep_time = frame_interval - elapsed
                    if sleep_time > 0:
                        time.sleep(sleep_time)

        except BrokenPipeError:
            print("Overlay pipe broken (FFmpeg closed)")
        except Exception as e:
            print(f"Overlay pipe error: {e}")
        finally:
            self._running = False


# =============================================================================
# FFmpeg Pipeline
# =============================================================================

class FFmpegPipeline:
    """Manages the FFmpeg compositing process."""

    def __init__(self):
        self.process: Optional[subprocess.Popen] = None

    def wait_for_input_stream(self, timeout: int = 60) -> bool:
        """Wait for the input RTMP stream to become available."""
        print(f"Waiting for input stream: {config.input_rtmp_url}")
        start_time = time.monotonic()

        while time.monotonic() - start_time < timeout:
            # Try to probe the stream with ffprobe
            result = subprocess.run(
                ["ffprobe", "-v", "quiet", "-i", config.input_rtmp_url],
                timeout=5,
                capture_output=True,
            )
            if result.returncode == 0:
                print("Input stream is available!")
                return True

            remaining = int(timeout - (time.monotonic() - start_time))
            print(f"  Stream not ready, retrying... ({remaining}s remaining)")
            time.sleep(2)

        print("ERROR: Timed out waiting for input stream")
        return False

    def start(self) -> bool:
        """Start the FFmpeg process."""
        if not config.output_rtmp_url:
            print("ERROR: OUTPUT_RTMP_URL not set")
            return False

        # Wait for input stream to be available
        if not self.wait_for_input_stream(timeout=120):
            return False

        print(f"Starting FFmpeg pipeline...")
        print(f"  Input:  {config.input_rtmp_url}")
        print(f"  Output: {config.output_rtmp_url}")

        # Build filter_complex string
        # 1. Convert overlay to RGBA to preserve alpha
        # 2. Scale game video to 900x600 with nearest neighbor (pixel art)
        # 3. Pad to 1280x720 with game at (0, 60) - 60px top padding
        # 4. Overlay the sidebar on top
        bg_color = f"0x{Colors.BG[0]:02x}{Colors.BG[1]:02x}{Colors.BG[2]:02x}"
        filter_complex = (
            f"[1:v]format=rgba,setpts=PTS-STARTPTS[ovl];"  # Reset PTS to avoid buffering
            f"[0:v]scale={config.game_width}:{config.game_height}:flags=neighbor[game];"
            f"[game]pad={config.output_width}:{config.output_height}:0:{config.game_y}:color={bg_color}[padded];"
            f"[padded][ovl]overlay=0:0:format=auto:shortest=1:eof_action=repeat[out]"  # shortest=1 forces sync
        )

        cmd = [
            "ffmpeg", "-y",
            # Input 0: RTMP stream from emulator
            "-fflags", "+genpts+nobuffer",
            "-flags", "low_delay",
            "-i", config.input_rtmp_url,
            # Input 1: Overlay PNG frames from named pipe
            # CRITICAL: nobuffer flags to prevent overlay lag
            "-fflags", "+nobuffer",
            "-flags", "low_delay",
            "-f", "image2pipe",
            "-framerate", str(config.overlay_fps),
            "-thread_queue_size", "2",  # Minimal queue to reduce buffering
            "-i", config.overlay_pipe_path,
            # Filter complex
            "-filter_complex", filter_complex,
            "-map", "[out]",
            "-map", "0:a",
            # Video encoding
            "-c:v", "libx264",
            "-preset", "fast",
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-g", "120",
            "-b:v", "3000k",
            # Audio encoding
            "-c:a", "aac",
            "-b:a", "128k",
            # Output
            "-f", "flv",
            "-flvflags", "no_duration_filesize",
            config.output_rtmp_url,
        ]

        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            print(f"FFmpeg started (pid={self.process.pid})")

            # Start a thread to log FFmpeg stderr
            threading.Thread(
                target=self._log_stderr,
                daemon=True
            ).start()

            return True
        except FileNotFoundError:
            print("ERROR: FFmpeg not found")
            return False
        except Exception as e:
            print(f"ERROR: Failed to start FFmpeg: {e}")
            return False

    def _log_stderr(self) -> None:
        """Log FFmpeg stderr output."""
        if not self.process or not self.process.stderr:
            return

        for line in self.process.stderr:
            # Only log important messages (skip progress spam)
            decoded = line.decode("utf-8", errors="replace").strip()
            if decoded and not decoded.startswith("frame="):
                print(f"[FFmpeg] {decoded}")

    def is_running(self) -> bool:
        """Check if FFmpeg is still running."""
        if not self.process:
            return False
        return self.process.poll() is None

    def stop(self) -> None:
        """Stop the FFmpeg process."""
        if self.process:
            print("Stopping FFmpeg...")
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            print("FFmpeg stopped")


# =============================================================================
# Main
# =============================================================================

def main():
    print("=" * 50)
    print("Claw Plays Pokemon - Compositor")
    print("=" * 50)
    print()
    print(f"API URL:     {config.api_url}")
    print(f"Input RTMP:  {config.input_rtmp_url}")
    print(f"Output RTMP: {config.output_rtmp_url or '(not set)'}")
    print(f"Poll interval: {config.status_poll_interval_ms}ms")
    print(f"Overlay FPS: {config.overlay_fps}")
    print()

    if not config.output_rtmp_url:
        print("ERROR: OUTPUT_RTMP_URL environment variable not set")
        print("Set it to your Twitch ingest URL, e.g.:")
        print("  rtmp://live.twitch.tv/app/YOUR_STREAM_KEY")
        sys.exit(1)

    # Create named pipe for overlay frames
    pipe_path = config.overlay_pipe_path
    if os.path.exists(pipe_path):
        os.unlink(pipe_path)
    os.mkfifo(pipe_path)
    print(f"Created overlay pipe: {pipe_path}")

    # Initialize components
    renderer = OverlayRenderer()
    api_client = APIClient()
    pipe_writer = OverlayPipeWriter(renderer, api_client)
    ffmpeg = FFmpegPipeline()

    # Set up signal handlers for graceful shutdown
    shutdown_event = threading.Event()

    def signal_handler(signum, frame):
        print(f"\nReceived signal {signum}, shutting down...")
        shutdown_event.set()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Start API polling
    print("Starting API polling...")
    api_client.start()

    # Wait a moment for first status fetch
    time.sleep(1)

    # Start pipe writer first (it will block until FFmpeg connects)
    print("Starting overlay pipe writer...")
    pipe_writer.start()

    # Give the pipe writer thread a moment to start
    time.sleep(0.1)

    # Start FFmpeg (this will unblock the pipe writer)
    if not ffmpeg.start():
        pipe_writer.stop()
        api_client.stop()
        sys.exit(1)

    # Wait for pipe to be connected
    print("Waiting for pipe connection...")
    if not pipe_writer.wait_for_pipe_ready(timeout=30):
        print("ERROR: Pipe connection timed out")
        ffmpeg.stop()
        api_client.stop()
        sys.exit(1)

    print()
    print("Compositor running. Press Ctrl+C to stop.")
    print()

    # Main loop: just monitor for shutdown
    try:
        while not shutdown_event.is_set():
            # Check if FFmpeg is still running
            if not ffmpeg.is_running():
                print("ERROR: FFmpeg process died")
                break

            shutdown_event.wait(timeout=1.0)

    except Exception as e:
        print(f"ERROR: {e}")

    finally:
        # Cleanup
        print()
        print("Shutting down...")
        pipe_writer.stop()
        api_client.stop()
        ffmpeg.stop()

        # Remove pipe
        try:
            os.unlink(pipe_path)
        except OSError:
            pass

        print("Compositor stopped.")


if __name__ == "__main__":
    main()
