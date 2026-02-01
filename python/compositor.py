"""
Stream compositor for rendering game + overlay.

Creates composite frames that show:
- Game screen (scaled)
- Vote tallies with progress bars
- Recent voters
- Countdown timer
- Last action

Supports both local preview mode (writes to file) and FFmpeg streaming.
"""

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from PIL import Image, ImageDraw, ImageFont


@dataclass
class VoteTally:
    """Represents vote count for a single button."""
    button: str
    count: int
    percentage: int
    voters: list[str]


@dataclass
class StreamState:
    """Complete state needed to render a stream frame."""
    game_frame: Image.Image
    time_remaining: int  # seconds
    tallies: list[VoteTally]
    recent_voters: list[tuple[str, str]]  # (name, button)
    last_winner: Optional[str]
    last_winner_votes: int


class StreamCompositor:
    """Renders game + overlay as composite frames."""

    # Layout constants (720p output)
    WIDTH = 1280
    HEIGHT = 720
    GAME_WIDTH = 720   # 160 * 4.5 (scaled from Game Boy 160x144)
    GAME_HEIGHT = 648  # 144 * 4.5
    SIDEBAR_WIDTH = 560
    SIDEBAR_X = 720

    # Colors (dark theme)
    BG_COLOR = (18, 18, 24)        # Dark purple-gray
    SIDEBAR_BG = (28, 28, 38)      # Slightly lighter
    ACCENT = (139, 92, 246)        # Purple
    ACCENT_BRIGHT = (167, 139, 250)  # Lighter purple
    TEXT_PRIMARY = (255, 255, 255)
    TEXT_SECONDARY = (156, 163, 175)
    BAR_BG = (55, 65, 81)
    SUCCESS = (34, 197, 94)        # Green

    # Button display symbols
    BUTTON_SYMBOLS = {
        "up": "UP",
        "down": "DOWN",
        "left": "LEFT",
        "right": "RIGHT",
        "a": "A",
        "b": "B",
        "start": "START",
        "select": "SELECT"
    }

    # Font paths to try (in order of preference)
    FONT_PATHS = [
        # 8-bit pixel font (preferred for Pokemon aesthetic)
        "./assets/fonts/PressStart2P-Regular.ttf",
        # Linux (Docker)
        "/app/assets/fonts/PressStart2P-Regular.ttf",
        # Fallback system fonts
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]

    def __init__(self, font_path: Optional[str] = None):
        """
        Initialize the compositor.

        Args:
            font_path: Optional specific font path. If not provided,
                       will try common system fonts.
        """
        self.font_path = self._find_font(font_path)
        self._load_fonts()

    def _find_font(self, preferred_path: Optional[str] = None) -> str:
        """Find an available font file."""
        if preferred_path and Path(preferred_path).exists():
            return preferred_path

        for path in self.FONT_PATHS:
            if Path(path).exists():
                return path

        # Fall back to PIL default (may look bad but won't crash)
        print("WARNING: No suitable font found, using PIL default")
        return ""

    def _load_fonts(self) -> None:
        """Load fonts at various sizes (optimized for pixel font)."""
        if self.font_path:
            try:
                # Sizes chosen for pixel-perfect rendering with Press Start 2P
                self.font_large = ImageFont.truetype(self.font_path, 24)
                self.font_medium = ImageFont.truetype(self.font_path, 16)
                self.font_small = ImageFont.truetype(self.font_path, 12)
                self.font_tiny = ImageFont.truetype(self.font_path, 10)
                return
            except Exception as e:
                print(f"WARNING: Failed to load font {self.font_path}: {e}")

        # Fall back to default font
        self.font_large = ImageFont.load_default()
        self.font_medium = ImageFont.load_default()
        self.font_small = ImageFont.load_default()
        self.font_tiny = ImageFont.load_default()

    def render_frame(self, state: StreamState) -> Image.Image:
        """
        Render a complete composite frame.

        Args:
            state: Current stream state with game frame and vote data

        Returns:
            PIL Image of the complete frame (1280x720)
        """
        # Create base canvas
        canvas = Image.new("RGB", (self.WIDTH, self.HEIGHT), self.BG_COLOR)
        draw = ImageDraw.Draw(canvas)

        # Scale and paste game frame
        # Game Boy is 160x144, we scale to fill left side nicely
        game_scaled = state.game_frame.resize(
            (self.GAME_WIDTH, self.GAME_HEIGHT),
            Image.NEAREST  # Pixel-perfect scaling for retro look
        )

        # Center game vertically
        game_y = (self.HEIGHT - self.GAME_HEIGHT) // 2
        canvas.paste(game_scaled, (0, game_y))

        # Draw sidebar background
        draw.rectangle(
            [(self.SIDEBAR_X, 0), (self.WIDTH, self.HEIGHT)],
            fill=self.SIDEBAR_BG
        )

        # Render sidebar content
        self._render_sidebar(draw, state)

        # Render footer
        self._render_footer(draw)

        return canvas

    def _render_sidebar(self, draw: ImageDraw.Draw, state: StreamState) -> None:
        """Render the sidebar with vote info."""
        y = 20
        pad_x = self.SIDEBAR_X + 20
        right_x = self.WIDTH - 20

        # Title + Timer
        draw.text(
            (pad_x, y),
            "Claw Plays Pokemon",
            font=self.font_large,
            fill=self.ACCENT
        )

        timer_text = f"{state.time_remaining}s"
        timer_bbox = draw.textbbox((0, 0), timer_text, font=self.font_large)
        timer_width = timer_bbox[2] - timer_bbox[0]
        draw.text(
            (right_x - timer_width, y),
            timer_text,
            font=self.font_large,
            fill=self.TEXT_PRIMARY
        )
        y += 50

        # Divider
        draw.line([(pad_x, y), (right_x, y)], fill=self.BAR_BG, width=2)
        y += 20

        # Section: Current Votes
        draw.text(
            (pad_x, y),
            "CURRENT VOTES",
            font=self.font_medium,
            fill=self.TEXT_SECONDARY
        )
        y += 35

        # Vote tallies
        max_bar_width = 280
        bar_x = self.SIDEBAR_X + 100

        for tally in state.tallies[:6]:  # Show top 6 buttons
            if tally.count == 0:
                continue

            symbol = self.BUTTON_SYMBOLS.get(tally.button, tally.button.upper())

            # Button name
            draw.text(
                (pad_x, y),
                symbol,
                font=self.font_medium,
                fill=self.TEXT_PRIMARY
            )

            # Background bar
            draw.rectangle(
                [(bar_x, y + 2), (bar_x + max_bar_width, y + 22)],
                fill=self.BAR_BG
            )

            # Filled portion
            bar_width = int((tally.percentage / 100) * max_bar_width)
            if bar_width > 0:
                draw.rectangle(
                    [(bar_x, y + 2), (bar_x + bar_width, y + 22)],
                    fill=self.ACCENT
                )

            # Count and percentage text
            count_text = f"{tally.count} ({tally.percentage}%)"
            draw.text(
                (bar_x + max_bar_width + 10, y + 2),
                count_text,
                font=self.font_small,
                fill=self.TEXT_SECONDARY
            )

            y += 32

        y += 10

        # Divider
        draw.line([(pad_x, y), (right_x, y)], fill=self.BAR_BG, width=2)
        y += 20

        # Section: Recent Voters
        draw.text(
            (pad_x, y),
            "RECENT VOTERS",
            font=self.font_medium,
            fill=self.TEXT_SECONDARY
        )
        y += 30

        for name, button in state.recent_voters[:8]:  # Last 8 voters
            symbol = self.BUTTON_SYMBOLS.get(button, button.upper())

            # Truncate long names
            display_name = name[:15] + "..." if len(name) > 15 else name
            voter_text = f"{display_name} -> {symbol}"

            draw.text(
                (pad_x + 5, y),
                voter_text,
                font=self.font_tiny,
                fill=self.TEXT_SECONDARY
            )
            y += 22

        y += 10

        # Divider
        draw.line([(pad_x, y), (right_x, y)], fill=self.BAR_BG, width=2)
        y += 15

        # Last action
        if state.last_winner:
            symbol = self.BUTTON_SYMBOLS.get(
                state.last_winner,
                state.last_winner.upper()
            )
            last_text = f"LAST: {symbol} ({state.last_winner_votes} votes)"
            draw.text(
                (pad_x, y),
                last_text,
                font=self.font_small,
                fill=self.SUCCESS
            )

    def _render_footer(self, draw: ImageDraw.Draw) -> None:
        """Render the footer with links."""
        footer_y = self.HEIGHT - 30
        footer_text = "twitch.tv/clawplayspokemon  |  #clawplayspokemon"

        footer_bbox = draw.textbbox((0, 0), footer_text, font=self.font_tiny)
        footer_width = footer_bbox[2] - footer_bbox[0]

        draw.text(
            ((self.WIDTH - footer_width) // 2, footer_y),
            footer_text,
            font=self.font_tiny,
            fill=self.TEXT_SECONDARY
        )


class LocalPreviewOutput:
    """Outputs composite frames to a local file for preview."""

    def __init__(self, output_path: str, compositor: StreamCompositor):
        """
        Initialize local preview output.

        Args:
            output_path: Path to write preview frames
            compositor: StreamCompositor instance
        """
        self.output_path = Path(output_path).resolve()
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.compositor = compositor

    def send_frame(self, state: StreamState) -> bool:
        """
        Render and save a frame to the preview file.

        Args:
            state: Current stream state

        Returns:
            True if successful, False otherwise
        """
        try:
            frame = self.compositor.render_frame(state)

            # Write to temp file first for atomicity
            temp_path = self.output_path.with_suffix(".tmp.png")
            frame.save(temp_path, "PNG")
            temp_path.replace(self.output_path)

            return True
        except Exception as e:
            print(f"ERROR: Failed to save preview frame: {e}")
            return False


class RTMPStreamer:
    """
    Streams video + audio to an RTMP server (local mediamtx or Twitch).

    Uses named pipes (FIFOs) with separate writer threads to avoid deadlocks.
    Critical FFmpeg flags eliminate the probing delay that causes RTMP timeouts.
    Audio is buffered to ensure consistent 48kHz output.
    """

    # Audio settings
    AUDIO_SAMPLE_RATE = 48000
    AUDIO_CHANNELS = 2
    AUDIO_BUFFER_MS = 100  # Buffer size in milliseconds

    def __init__(self, rtmp_url: str, compositor: StreamCompositor):
        """
        Initialize the RTMP streamer.

        Args:
            rtmp_url: RTMP URL (e.g., rtmp://localhost:1935/live/clawplayspokemon)
            compositor: StreamCompositor instance
        """
        import queue
        import tempfile
        import threading
        import numpy as np

        self.rtmp_url = rtmp_url
        self.compositor = compositor
        self.ffmpeg_process: Optional[subprocess.Popen] = None
        self.running = False

        # Named pipes (more reliable than pass_fds)
        self.video_pipe_path = os.path.join(tempfile.gettempdir(), f'clawplayspokemon_video_{os.getpid()}')
        self.audio_pipe_path = os.path.join(tempfile.gettempdir(), f'clawplayspokemon_audio_{os.getpid()}')

        # File handles for writing
        self._video_pipe_file = None
        self._audio_pipe_file = None

        # Queues for async writing
        self._frame_queue: queue.Queue = queue.Queue(maxsize=5)

        # Audio buffer for consistent output
        self._audio_buffer = np.array([], dtype=np.int16)
        self._audio_lock = threading.Lock()
        # Samples to output per chunk
        self._audio_chunk_samples = self.AUDIO_SAMPLE_RATE // 30 * self.AUDIO_CHANNELS

        # Writer threads
        self._video_thread = None
        self._audio_thread = None

    def start(self) -> bool:
        """Start the FFmpeg RTMP streaming process with named pipes."""
        import threading

        if not self.rtmp_url:
            print("ERROR: No RTMP URL provided")
            return False

        print(f"Starting RTMP stream to: {self.rtmp_url}")

        # Create named pipes
        for pipe_path in [self.video_pipe_path, self.audio_pipe_path]:
            if os.path.exists(pipe_path):
                os.unlink(pipe_path)
            os.mkfifo(pipe_path)

        print(f"  Video pipe: {self.video_pipe_path}")
        print(f"  Audio pipe: {self.audio_pipe_path}")

        # FFmpeg command with CRITICAL flags to eliminate probing delay
        cmd = [
            "ffmpeg", "-y",
            # Global flags - CRITICAL for low latency
            "-fflags", "+genpts+nobuffer+discardcorrupt",
            "-flags", "low_delay",
            # Video input - minimal probing
            "-probesize", "32",
            "-analyzeduration", "0",
            "-thread_queue_size", "1024",
            "-f", "rawvideo",
            "-pixel_format", "rgb24",
            "-video_size", f"{StreamCompositor.WIDTH}x{StreamCompositor.HEIGHT}",
            "-framerate", "30",
            "-i", self.video_pipe_path,
            # Audio input
            "-thread_queue_size", "1024",
            "-f", "s16le",
            "-ar", "48000",
            "-ac", "2",
            "-i", self.audio_pipe_path,
            # Video encoding
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-pix_fmt", "yuv420p",
            "-g", "60",
            # Audio encoding
            "-c:a", "aac",
            "-b:a", "128k",
            # Output flags - CRITICAL for RTMP
            "-flags", "+global_header",
            "-max_delay", "0",
            "-muxdelay", "0",
            "-flush_packets", "1",
            "-f", "flv",
            "-flvflags", "no_duration_filesize",
            self.rtmp_url
        ]

        try:
            print("  Starting FFmpeg...")
            self.ffmpeg_process = subprocess.Popen(
                cmd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE
            )
            print(f"  FFmpeg started (pid={self.ffmpeg_process.pid})")

            # Mark as running before starting threads
            self.running = True

            # Start separate writer threads (CRITICAL: must be separate to avoid deadlock)
            self._video_thread = threading.Thread(target=self._video_writer_loop, daemon=True)
            self._audio_thread = threading.Thread(target=self._audio_writer_loop, daemon=True)
            self._video_thread.start()
            self._audio_thread.start()

            print(f"RTMP stream started!")
            print(f"  View with: mpv {self.rtmp_url}")
            return True

        except FileNotFoundError:
            print("ERROR: FFmpeg not found. Install with: brew install ffmpeg")
            self._cleanup_pipes()
            return False
        except Exception as e:
            print(f"ERROR: Failed to start FFmpeg: {e}")
            import traceback
            traceback.print_exc()
            self._cleanup_pipes()
            return False

    def _video_writer_loop(self) -> None:
        """Background thread that writes video frames to FFmpeg."""
        import queue

        print("  Video thread: waiting to open pipe...")
        try:
            # Open pipe for writing (blocks until FFmpeg opens for reading)
            with open(self.video_pipe_path, 'wb') as f:
                self._video_pipe_file = f
                print("  Video thread: pipe opened")
                while self.running:
                    try:
                        frame_bytes = self._frame_queue.get(timeout=0.1)
                        f.write(frame_bytes)
                        f.flush()
                    except queue.Empty:
                        pass
                    except BrokenPipeError:
                        print("Video pipe broken")
                        self.running = False
                        break

        except Exception as e:
            print(f"Video writer error: {e}")
            self.running = False

    def _audio_writer_loop(self) -> None:
        """Background thread that writes audio to FFmpeg at consistent rate."""
        import time
        import numpy as np

        print("  Audio thread: waiting to open pipe...")
        try:
            # Open pipe for writing (blocks until FFmpeg opens for reading)
            with open(self.audio_pipe_path, 'wb') as f:
                self._audio_pipe_file = f
                print("  Audio thread: pipe opened, writing audio...")

                # Output at 30 chunks per second (matching video frame rate)
                chunk_interval = 1.0 / 30
                samples_per_chunk = self.AUDIO_SAMPLE_RATE * self.AUDIO_CHANNELS // 30
                silence = np.zeros(samples_per_chunk, dtype=np.int16)

                bytes_written = 0
                last_time = time.monotonic()

                while self.running:
                    now = time.monotonic()
                    elapsed = now - last_time

                    if elapsed >= chunk_interval:
                        last_time = now

                        # Get samples from buffer
                        with self._audio_lock:
                            if len(self._audio_buffer) >= samples_per_chunk:
                                chunk = self._audio_buffer[:samples_per_chunk]
                                self._audio_buffer = self._audio_buffer[samples_per_chunk:]
                            elif len(self._audio_buffer) > 0:
                                # Pad with silence if not enough samples
                                chunk = np.concatenate([
                                    self._audio_buffer,
                                    np.zeros(samples_per_chunk - len(self._audio_buffer), dtype=np.int16)
                                ])
                                self._audio_buffer = np.array([], dtype=np.int16)
                            else:
                                # No audio, output silence
                                chunk = silence

                        try:
                            f.write(chunk.tobytes())
                            f.flush()
                            bytes_written += len(chunk) * 2
                        except BrokenPipeError:
                            print("Audio pipe broken")
                            self.running = False
                            break
                    else:
                        # Sleep briefly to avoid busy-waiting
                        time.sleep(0.001)

        except Exception as e:
            print(f"Audio writer error: {e}")
            self.running = False

    def send_frame(self, state: StreamState) -> bool:
        """Queue a video frame for sending (non-blocking)."""
        import queue

        if not self.running:
            return False

        try:
            frame = self.compositor.render_frame(state)
            self._frame_queue.put_nowait(frame.tobytes())
            return True
        except queue.Full:
            return False  # Frame dropped
        except Exception as e:
            print(f"ERROR: Failed to queue frame: {e}")
            return False

    def send_audio(self, audio_data, volume_boost: float = 3.0) -> bool:
        """Add audio samples to buffer (non-blocking)."""
        import numpy as np

        if not self.running:
            return False

        try:
            if hasattr(audio_data, 'tobytes'):
                # Boost volume and clamp to int16 range
                boosted = (audio_data.astype('float32') * volume_boost).clip(-32768, 32767)
                samples = boosted.astype(np.int16).flatten()
            else:
                samples = np.frombuffer(bytes(audio_data), dtype=np.int16)

            # Add to buffer (thread-safe)
            with self._audio_lock:
                self._audio_buffer = np.concatenate([self._audio_buffer, samples])

                # Prevent buffer from growing too large (keep ~500ms max)
                max_samples = self.AUDIO_SAMPLE_RATE * self.AUDIO_CHANNELS // 2
                if len(self._audio_buffer) > max_samples:
                    self._audio_buffer = self._audio_buffer[-max_samples:]

            return True
        except Exception as e:
            print(f"Audio buffer error: {e}")
            return False

    def _cleanup_pipes(self) -> None:
        """Remove named pipe files."""
        for pipe_path in [self.video_pipe_path, self.audio_pipe_path]:
            try:
                if os.path.exists(pipe_path):
                    os.unlink(pipe_path)
            except Exception:
                pass

    def stop(self) -> None:
        """Stop the streaming pipeline."""
        print("Stopping RTMP stream...")
        self.running = False

        # Wait for writer threads to finish
        if self._video_thread:
            self._video_thread.join(timeout=2)
        if self._audio_thread:
            self._audio_thread.join(timeout=2)

        # Stop FFmpeg
        if self.ffmpeg_process:
            try:
                self.ffmpeg_process.terminate()
                self.ffmpeg_process.wait(timeout=5)
            except Exception as e:
                print(f"WARNING: Error stopping FFmpeg: {e}")
                self.ffmpeg_process.kill()

        # Clean up pipes
        self._cleanup_pipes()

        print("RTMP stream stopped")


# Keep these as aliases for backwards compatibility
LocalVideoPreview = RTMPStreamer
StreamPipeline = RTMPStreamer
