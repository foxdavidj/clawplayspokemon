# GBA Stream — Development Guide

This document is the authoritative reference for continuing development on this project. It covers the full architecture, every decision made and why, every bug encountered and how it was fixed, the current state of the system, and detailed specifications for the work remaining.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Current State — What Works](#current-state--what-works)
4. [Emulator Container — Deep Dive](#emulator-container--deep-dive)
5. [Bugs Encountered and Fixes](#bugs-encountered-and-fixes)
6. [RetroArch Interfaces — Input, Memory, Streaming](#retroarch-interfaces--input-memory-streaming)
7. [The RTMP Server](#the-rtmp-server)
8. [The API Server (Not Yet Built)](#the-api-server-not-yet-built)
9. [The Overlay/Compositor Container (Not Yet Built)](#the-overlaycompositor-container-not-yet-built)
10. [Twitch Restreaming](#twitch-restreaming)
11. [Pokemon-Specific Memory Maps](#pokemon-specific-memory-maps)
12. [Testing Checklist](#testing-checklist)
13. [Common Pitfalls and Gotchas](#common-pitfalls-and-gotchas)
14. [File-by-File Reference](#file-by-file-reference)

---

## Project Overview

This is a "Twitch Plays Pokemon" style application. The system:

1. Runs a GBA/GB/GBC game headlessly in a Docker container.
2. Streams the raw gameplay video+audio over RTMP to an internal media server.
3. Exposes UDP interfaces for injecting controller inputs and reading emulator RAM.
4. An API server (separate container) collects votes from users, resolves them on a timer, and sends the winning input to the emulator. It also serves game state (badges, HP, position) by reading RAM, and serves screenshots.
5. An overlay/compositor container consumes the raw RTMP stream, composites a vote UI overlay on top (current votes, time remaining, game state), and pushes the final combined stream to Twitch/YouTube.

The key design principle is **separation of concerns** — the emulator container is dumb. It plays a game, streams it, and accepts inputs. It knows nothing about votes, overlays, or Twitch. The API server handles all game logic. The compositor handles all presentation.

---

## Architecture

```
                        ┌──────────────────────────────────────────────────┐
                        │                   Internet                       │
                        └───────────┬──────────────────┬───────────────────┘
                                    │                  │
                              Votes (HTTP)       Watch (Twitch)
                                    │                  ▲
                                    ▼                  │
┌──────────────────┐       ┌──────────────────┐       │
│                  │ UDP   │                  │       │
│  API Server      │──────▶│  Emulator        │       │
│                  │:55400 │  (RetroArch +    │       │
│  - POST /vote    │       │   mGBA core)     │       │
│  - GET /state    │◀─────▶│                  │       │
│  - GET /screenshot│:55355│  Streams raw     │       │
│                  │       │  A/V to RTMP     │       │
└──────────────────┘       └───────┬──────────┘       │
        │                          │                  │
        │ vote data,               │ rtmp://          │
        │ game state               │ rtmp/live/raw    │
        │ (HTTP/WS)                ▼                  │
        │                  ┌──────────────────┐       │
        └─────────────────▶│                  │       │
                           │  Overlay /       │───────┘
                           │  Compositor      │  rtmp:// or direct
                           │                  │  to Twitch ingest
                           │  FFmpeg merges   │
                           │  raw stream +    │
                           │  overlay image   │
                           └──────────────────┘
                                   ▲
                                   │
                           ┌──────────────────┐
                           │  mediamtx        │
                           │  (RTMP server)   │
                           │  :1935 RTMP      │
                           │  :8554 RTSP      │
                           │  :8888 HLS       │
                           └──────────────────┘
```

### Container Inventory

| Container | Image / Build | Ports | Status |
|-----------|---------------|-------|--------|
| `rtmp` | `bluenviron/mediamtx:latest` | 1935 (RTMP), 8554 (RTSP), 8888 (HLS) | ✅ Working |
| `emulator` | Custom `./emulator/Dockerfile` | 55355/udp (commands), 55400/udp (gamepad) | ✅ Working |
| `api` | TBD | 8000 or similar (HTTP) | ❌ Not built |
| `compositor` | TBD | Possibly none (pushes outbound to Twitch) | ❌ Not built |

---

## Current State — What Works

As of now, the following is verified working on an M1 Mac with Docker Desktop:

- **mediamtx** starts and listens on RTMP :1935.
- **Emulator container** builds, starts Xvfb, finds the mGBA core, auto-detects a ROM, and launches RetroArch with `--record` pointed at the RTMP server.
- **The game runs and streams.** Verified by watching with `mpv --profile=low-latency rtmp://localhost:1935/live/stream`.
- **Audio and video both stream.** The recording config encodes with libx264 + aac → flv container → RTMP.
- **Network command interface is enabled** (port 55355) for future RAM reading.
- **Network gamepad is enabled** (port 55400) for future input injection.

What has NOT been tested yet:

- Actually sending UDP input commands to port 55400.
- Actually sending `READ_CORE_MEMORY` commands to port 55355.
- Running with a GBA ROM (tested with Pokemon Red which is a .gb ROM — Game Boy, not Game Boy Advance — but the mGBA core handles both).
- The overlay/compositor pipeline.
- The API server.

---

## Emulator Container — Deep Dive

### Dockerfile

Base image: `ubuntu:24.04`. Packages installed:

- `retroarch` — The emulator frontend. Ubuntu 24.04's package includes SDL2, X11, Wayland, OpenGL, OpenGLES, Vulkan, and EGL support. Confirmed via `retroarch --features` output.
- `libretro-mgba` — The mGBA libretro core. Installs to `/usr/lib/aarch64-linux-gnu/libretro/mgba_libretro.so` on ARM64 (the M1 Mac path). On x86_64 it would be `/usr/lib/x86_64-linux-gnu/libretro/mgba_libretro.so`. The entrypoint uses `find` to locate it dynamically.
- `xvfb` — X Virtual Framebuffer. Creates a fake X11 display in memory so RetroArch has something to render to. Without this, RetroArch cannot initialize its video driver and will not produce frames.
- `ffmpeg` — Required by RetroArch's `--record` feature for encoding.
- `netcat-openbsd` — Used in entrypoint to `nc -z` test whether the RTMP server is up before launching RetroArch.
- `dbus-x11` — Provides `dbus-launch`. **Critical.** Without a D-Bus session, RetroArch crashes on startup due to GameMode trying to connect to the system bus. See [Bugs section](#bugs-encountered-and-fixes).

### retroarch.cfg

Key settings and why:

```ini
video_driver = "sdl2"        # Renders to the Xvfb X11 display
audio_driver = "sdl2"        # Paired with SDL_AUDIODRIVER=dummy env var
pause_nonactive = "false"    # CRITICAL: without this, RetroArch pauses when
                              # the window loses focus, which in a headless
                              # container means it would pause immediately
network_cmd_enable = "true"   # Enables UDP command interface on port 55355
network_cmd_port = "55355"
network_remote_enable = "true"              # Enables network gamepad
network_remote_enable_user_p1 = "true"      # Enables it for player 1
network_remote_base_port = "55400"          # UDP port for player 1 input
```

The `video_driver` MUST be one that actually renders frames. You cannot use `video_driver = "null"` if you want `--record` to work, because the recording hooks into the rendered frames. `sdl2` rendering to Xvfb is the correct approach.

### recording.cfg

```ini
vcodec = libx264
acodec = aac
pix_fmt = yuv420p
scale_factor = 3           # Upscales GBA's 240x160 by 3x to 720x480
threads = 2
format = flv               # Required for RTMP
video_preset = ultrafast    # Minimal CPU usage for encoding
video_tune = zerolatency    # Disables B-frames, reduces encoder buffering
video_crf = 23              # Quality level (lower = better, 23 is default)
video_g = 30                # Keyframe every 30 frames (~0.5s at 60fps)
                            # This is CRITICAL for low-latency streaming.
                            # Without it, FFmpeg defaults to keyframe every
                            # 250 frames, causing 5-10 second buffering stalls
                            # on the player side.
sample_rate = 44100
```

### entrypoint.sh

The entrypoint does these things in order:

1. Starts Xvfb on display :99, waits 2 seconds, verifies it's running.
2. Waits up to 30 seconds for the RTMP server to be reachable on port 1935 (using `nc -z`).
3. Finds the mGBA libretro core using `find /usr/lib`.
4. Finds a ROM: checks `$ROM_PATH` env var first, then auto-detects the first `.gba`/`.gbc`/`.gb` file in `/roms/`.
5. Prints `retroarch --features` for debugging.
6. Starts a D-Bus session with `eval $(dbus-launch --sh-syntax)`.
7. `exec`s RetroArch with the core, ROM, and `--record` pointed at `$RTMP_URL`.

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DISPLAY` | `:99` | Set in docker-compose.yml. Must match Xvfb display number. |
| `SDL_VIDEODRIVER` | `x11` | Forces SDL2 to use X11 (the Xvfb display). |
| `SDL_AUDIODRIVER` | `dummy` | No real audio hardware in container. SDL2 dummy driver discards audio output but RetroArch still captures it for recording. |
| `RTMP_URL` | `rtmp://rtmp:1935/live/stream` | Where RetroArch sends the recorded stream. |
| `ROM_PATH` | (auto-detect) | Optional. Filename or full path to the ROM. |

---

## Bugs Encountered and Fixes

### Bug 1: D-Bus / GameMode crash (exit code 133)

**Symptom:** RetroArch exits immediately with code 133. Logs show:

```
GameMode ERROR: Could not connect to bus: /usr/bin/dbus-launch terminated abnormally
dbus[1]: arguments to dbus_connection_unref() were incorrect, assertion "connection != NULL" failed
```

**Cause:** RetroArch (or a library it loads) tries to connect to GameMode, a Linux performance optimization daemon, via D-Bus. In a container with no D-Bus session bus, this causes an assertion failure that kills the process.

**Fix:** Install `dbus-x11` package and run `eval $(dbus-launch --sh-syntax)` before launching RetroArch. This creates a minimal session bus that satisfies the D-Bus client. GameMode itself doesn't need to do anything useful — it just needs to not crash.

**Alternative fix (not tested but should work):** Set `DBUS_SESSION_BUS_ADDRESS=/dev/null` or find a RetroArch config to disable GameMode. The dbus-launch approach is cleaner.

### Bug 2: 5-10 second buffering stalls on the player

**Symptom:** mpv plays the stream but stalls/rebuffers every 5-10 seconds.

**Cause:** FFmpeg's default keyframe interval is every 250 frames. RTMP players can only seek to keyframes, so with default settings the player has to buffer ~4-8 seconds of data before it can start decoding. When combined with network jitter, this manifests as periodic stalls.

**Fix:** Two-pronged:

1. Set `video_g = 30` in `recording.cfg` to emit a keyframe every 30 frames (~0.5 seconds).
2. Set `video_tune = zerolatency` to disable B-frames and reduce encoder-side buffering.
3. On the player side, use `mpv --profile=low-latency` to minimize player-side buffering.

### Bug 3 (potential): xkbcomp keysym warnings

**Symptom:** Xvfb prints many warnings like `Could not resolve keysym XF86CameraAccessEnable`.

**Impact:** None. These are cosmetic warnings about extended keyboard symbols that don't exist in the Xvfb keymap. They do not affect functionality. The log even says "Errors from xkbcomp are not fatal to the X server."

**Fix:** No fix needed. Can be suppressed by redirecting Xvfb stderr to /dev/null if the log noise is annoying: `Xvfb :99 ... 2>/dev/null &`

### Bug 4 (potential): `--record` silently does nothing

**Symptom:** RetroArch starts but no RTMP connection appears in the mediamtx logs.

**Cause:** If the Ubuntu `retroarch` package was built without FFmpeg support, `--record` silently fails. Check the `retroarch --features` output for an FFmpeg line.

**Fix:** If FFmpeg support is missing from the RetroArch binary, fall back to capturing the Xvfb display with FFmpeg directly:

```bash
# In entrypoint.sh, instead of --record on the retroarch command:
retroarch -L "$CORE" "$ROM_PATH" &
sleep 3
ffmpeg -f x11grab -video_size 720x480 -framerate 60 -i :99.0 \
    -f pulse -ac 2 -i default \
    -c:v libx264 -preset ultrafast -tune zerolatency \
    -c:a aac -b:a 128k \
    -g 30 -pix_fmt yuv420p \
    -f flv "$RTMP_URL"
```

This was NOT needed — the Ubuntu 24.04 retroarch package does have `--record` support. But this is the fallback if it ever breaks.

### Bug 5 (potential): Audio issues with x11grab fallback

If using the FFmpeg x11grab fallback above, audio capture from `pulse` won't work with `SDL_AUDIODRIVER=dummy`. You'd need to set up PulseAudio in the container and route RetroArch's audio through it. This is significantly more complex. The native `--record` approach avoids this entirely because RetroArch captures audio internally before it hits the audio driver.

---

## RetroArch Interfaces — Input, Memory, Streaming

### Input Injection (UDP port 55400)

RetroArch's network gamepad receives button states as raw integers over UDP. Each packet is a string representation of a bitmask.

```python
import socket
import time

# Button bitmask values
BUTTONS = {
    "A":      0b000000001,   # 1
    "B":      0b000000010,   # 2
    "SELECT": 0b000000100,   # 4
    "START":  0b000001000,   # 8
    "RIGHT":  0b000010000,   # 16
    "LEFT":   0b000100000,   # 32
    "UP":     0b001000000,   # 64
    "DOWN":   0b010000000,   # 128
    "R":      0b100000000,   # 256
    "L":      0b1000000000,  # 512
}

def press_button(button_name, host="127.0.0.1", port=55400, duration=0.1):
    """Press and release a button."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    bitmask = BUTTONS[button_name.upper()]
    # Press
    sock.sendto(str(bitmask).encode(), (host, port))
    time.sleep(duration)
    # Release
    sock.sendto(b"0", (host, port))
    sock.close()

def press_buttons(button_names, host="127.0.0.1", port=55400, duration=0.1):
    """Press multiple buttons simultaneously."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    bitmask = 0
    for name in button_names:
        bitmask |= BUTTONS[name.upper()]
    sock.sendto(str(bitmask).encode(), (host, port))
    time.sleep(duration)
    sock.sendto(b"0", (host, port))
    sock.close()
```

**Important:** The packet payload is just the integer as a UTF-8 string. Not binary. Not JSON. Just `"64"` for up, `"0"` for release all. The port `55400` is for player 1; player 2 would be `55401`, etc.

**Testing from command line:**

```bash
# Press A
echo -n "1" | nc -u -w0 localhost 55400
# Press Up
echo -n "64" | nc -u -w0 localhost 55400
# Release all
echo -n "0" | nc -u -w0 localhost 55400
```

### Memory Inspection (UDP port 55355)

RetroArch's network command interface accepts text commands over UDP and returns text responses.

**Read memory:**

```bash
# Read 16 bytes starting at address 0x02000000 (EWRAM on GBA)
echo -n "READ_CORE_MEMORY 02000000 16" | nc -u -w1 localhost 55355
# Response: READ_CORE_MEMORY 02000000 AB CD EF 01 ...
```

**Write memory:**

```bash
echo -n "WRITE_CORE_MEMORY 02000000 FF 00 12" | nc -u -w1 localhost 55355
```

**Other useful commands:**

```bash
# Pause/unpause
echo -n "PAUSE_TOGGLE" | nc -u -w1 localhost 55355

# Save state
echo -n "SAVE_STATE" | nc -u -w1 localhost 55355

# Load state
echo -n "LOAD_STATE" | nc -u -w1 localhost 55355

# Get current status
echo -n "GET_STATUS" | nc -u -w1 localhost 55355

# Screenshot (saves to filesystem inside container)
echo -n "SCREENSHOT" | nc -u -w1 localhost 55355
```

**Python wrapper:**

```python
import socket

def read_memory(address, length, host="127.0.0.1", port=55355, timeout=2.0):
    """Read `length` bytes from the emulator's memory at `address`.
    Returns a list of integer byte values, or None on failure.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    cmd = f"READ_CORE_MEMORY {address:08X} {length}"
    sock.sendto(cmd.encode(), (host, port))
    try:
        data, _ = sock.recvfrom(65535)
        response = data.decode().strip()
        # Response format: "READ_CORE_MEMORY ADDR XX XX XX ..."
        parts = response.split()
        if parts[0] == "READ_CORE_MEMORY" and len(parts) > 2:
            hex_bytes = parts[2:]  # Skip command name and address echo
            return [int(b, 16) for b in hex_bytes]
        elif parts[0] == "-1":
            # Error response
            return None
    except socket.timeout:
        return None
    finally:
        sock.close()

def write_memory(address, byte_values, host="127.0.0.1", port=55355):
    """Write bytes to emulator memory."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    hex_str = " ".join(f"{b:02X}" for b in byte_values)
    cmd = f"WRITE_CORE_MEMORY {address:08X} {hex_str}"
    sock.sendto(cmd.encode(), (host, port))
    sock.close()
```

**Important caveats:**

- The `READ_CORE_MEMORY` / `WRITE_CORE_MEMORY` commands operate on the core's memory map. For mGBA, this means GBA addresses directly: `0x02000000` for EWRAM, `0x03000000` for IWRAM, `0x0E000000` for SRAM.
- For Game Boy / Game Boy Color ROMs (like Pokemon Red), the memory map is different. WRAM starts at `0xC000`, SRAM at `0xA000`. The mGBA core handles both GBA and GB/GBC.
- UDP is unreliable by nature. For critical reads (game state for API), implement a retry with timeout.
- The response comes back on the same socket. You must `recvfrom` after `sendto`.

### Streaming (--record)

RetroArch's `--record` flag uses FFmpeg internally to encode frames in real time. It hooks directly into the rendering pipeline — it captures frames AFTER the core renders them but BEFORE they go to the video driver. This means:

- The recording resolution matches the core's output × `scale_factor` from `recording.cfg`.
- Audio is captured from the core's audio output, independent of the audio driver. So `SDL_AUDIODRIVER=dummy` still produces recorded audio.
- The encoding runs in-process. CPU-heavy encoding presets will slow down the emulation. `ultrafast` is the right choice for a GBA game.

The `--recordconfig` file uses FFmpeg option names but with RetroArch-specific key names. The mapping:

| recording.cfg key | FFmpeg equivalent |
|---|---|
| `vcodec` | `-c:v` |
| `acodec` | `-c:a` |
| `pix_fmt` | `-pix_fmt` |
| `video_preset` | `-preset` |
| `video_tune` | `-tune` |
| `video_crf` | `-crf` |
| `video_g` | `-g` (keyframe interval) |
| `format` | `-f` (must be `flv` for RTMP) |
| `scale_factor` | Upscale multiplier before encoding |
| `threads` | `-threads` |

---

## The RTMP Server

Using `bluenviron/mediamtx:latest` as a zero-config media server. It accepts RTMP input and can serve it back via multiple protocols:

| Protocol | URL | Use case |
|----------|-----|----------|
| RTMP | `rtmp://localhost:1935/live/stream` | Low-latency playback (mpv, ffplay, VLC), FFmpeg consumption |
| RTSP | `rtsp://localhost:8554/live/stream` | Alternative for some players |
| HLS | `http://localhost:8888/live/stream/` | Browser playback (higher latency, ~5-10s) |
| WebRTC | `http://localhost:8889/live/stream/` | Ultra-low-latency browser playback |

For the compositor container, it should consume via RTMP (`rtmp://rtmp:1935/live/stream` using the Docker network hostname). RTMP is the lowest-latency option that FFmpeg can consume as an input.

mediamtx requires zero configuration for this use case. It auto-creates stream paths on first publish.

---

## The API Server (Not Yet Built)

This container sits between users and the emulator. Specification:

### Endpoints

**POST /vote** — Submit a vote for the next input.

```json
{
  "button": "UP"  // A, B, START, SELECT, UP, DOWN, LEFT, RIGHT, L, R
}
```

The server accumulates votes for a configurable time window (e.g., 10 seconds). When the window closes, the winning button (most votes) is sent to the emulator via UDP on port 55400, then the vote window resets.

**GET /state** — Returns current game state by reading emulator RAM.

```json
{
  "badges": ["Boulder", "Cascade"],
  "party": [
    {"name": "PIKACHU", "level": 25, "hp": 58, "max_hp": 62}
  ],
  "location": "Cerulean City",
  "money": 12500
}
```

This endpoint sends `READ_CORE_MEMORY` commands to the emulator on port 55355 and decodes the response using known Pokemon memory offsets.

**GET /screenshot** — Returns a JPEG/PNG screenshot of the current game frame. Options:

1. Send `SCREENSHOT` command to RetroArch (saves to filesystem in the emulator container, requires a shared volume or API to retrieve it).
2. Grab a single frame from the RTMP stream with FFmpeg: `ffmpeg -i rtmp://rtmp:1935/live/stream -frames:v 1 -f image2pipe -vcodec png pipe:1`. This is probably simpler since it doesn't require filesystem coordination.

**GET /votes** — Returns current vote tally and time remaining. Used by the compositor overlay.

```json
{
  "votes": {"UP": 12, "A": 8, "DOWN": 3},
  "time_remaining_ms": 4200,
  "window_duration_ms": 10000
}
```

### Communication with Emulator

The API server talks to the emulator container over UDP. In Docker Compose, the emulator's hostname is `emulator`. So the API server sends packets to `emulator:55400` (inputs) and `emulator:55355` (memory commands).

Docker Compose networking handles the DNS resolution automatically. No special network configuration is needed — all services in the same compose file share a default bridge network.

---

## The Overlay/Compositor Container (Not Yet Built)

This is the final piece. Its job:

1. Consume the raw gameplay stream from `rtmp://rtmp:1935/live/stream`.
2. Generate an overlay image showing vote tallies, time remaining, game state, etc.
3. Composite the overlay on top of the gameplay video.
4. Push the final combined stream to Twitch (or another RTMP destination).

### Approach A: FFmpeg + Dynamic Overlay Image (Recommended)

The simplest approach that maintains separation of concerns:

1. A small HTTP server (or file watcher) inside the compositor container generates a transparent PNG overlay image, updated every second by polling the API server's `/votes` endpoint.
2. FFmpeg reads the raw RTMP stream as input, reads the overlay PNG, and composites them together in real-time using the `overlay` filter.
3. FFmpeg outputs the composited stream to Twitch's RTMP ingest.

```bash
# Conceptual FFmpeg command for the compositor
ffmpeg \
    -i rtmp://rtmp:1935/live/stream \           # Raw gameplay from emulator
    -stream_loop -1 -i /tmp/overlay.png \       # Overlay image (refreshed by a script)
    -filter_complex "[0:v][1:v]overlay=0:0:format=auto,format=yuv420p" \
    -c:v libx264 -preset fast -tune zerolatency -g 60 \
    -c:a aac -b:a 128k \
    -f flv "rtmp://live.twitch.tv/app/{STREAM_KEY}"
```

**Problem with the simple approach:** FFmpeg reads the overlay image once at startup. To get a *dynamic* overlay that changes, you need one of:

**Option 1: Periodic image replacement with `sendcmd` / segment muxer** — Complex and fragile.

**Option 2: Use `movie` filter with `-stream_loop`** — Still reads the file once.

**Option 3 (Recommended): Named pipe or image2pipe for the overlay source:**

A Python/Node script continuously generates overlay frames (as raw video) and pipes them into FFmpeg:

```bash
# The overlay generator script writes raw RGBA frames to a named pipe
mkfifo /tmp/overlay_pipe

# Python script writes 1 frame per second to the pipe
python3 overlay_generator.py > /tmp/overlay_pipe &

# FFmpeg reads the pipe as a video input
ffmpeg \
    -i rtmp://rtmp:1935/live/stream \
    -f rawvideo -pixel_format rgba -video_size 720x480 -framerate 1 -i /tmp/overlay_pipe \
    -filter_complex "[1:v]setpts=PTS-STARTPTS[ovr];[0:v][ovr]overlay=0:0:format=auto:shortest=0" \
    -c:v libx264 -preset fast -tune zerolatency \
    -c:a copy \
    -f flv "rtmp://live.twitch.tv/app/{STREAM_KEY}"
```

**Option 4 (Simplest, recommended to try first): Use `drawtext` filter with a text file:**

FFmpeg's `drawtext` filter can read text from a file and re-reads it every frame:

```bash
ffmpeg \
    -i rtmp://rtmp:1935/live/stream \
    -vf "drawtext=textfile=/tmp/overlay.txt:reload=1:fontsize=24:fontcolor=white:x=10:y=10:box=1:boxcolor=black@0.7:boxborderw=10" \
    -c:v libx264 -preset fast -tune zerolatency \
    -c:a copy \
    -f flv "rtmp://live.twitch.tv/app/{STREAM_KEY}"
```

Then a Python script updates `/tmp/overlay.txt` every second:

```python
import time, requests

while True:
    data = requests.get("http://api:8000/votes").json()
    lines = []
    lines.append(f"Time remaining: {data['time_remaining_ms'] // 1000}s")
    for button, count in sorted(data['votes'].items(), key=lambda x: -x[1]):
        lines.append(f"  {button}: {count}")
    with open("/tmp/overlay.txt", "w") as f:
        f.write("\n".join(lines))
    time.sleep(1)
```

This is the least pretty but easiest to get working. Good for V1.

**Option 5 (Prettiest): Headless browser rendering the overlay:**

Run a headless Chromium that renders a web page with the vote UI, capture the browser output as a video source for FFmpeg. This gives you full HTML/CSS/JS control over the overlay design. Projects like `headless-chrome-capture` or using `xdotool` + `xvfb` + Chromium exist for this. This is the most complex approach but produces the best-looking result.

### Approach B: OBS in Docker

There are Docker images for OBS Studio (e.g., with VNC access). OBS has native browser source support, RTMP input, and Twitch output. But running OBS headlessly in Docker is heavy and fragile. Not recommended for this use case.

### Recommended Path

Start with **Option 4 (drawtext)** to prove the pipeline works end to end. Then upgrade to **Option 3 (image pipe)** with a Python script using Pillow to generate prettier PNG overlays. If you need a really polished UI, move to **Option 5 (headless browser)** later.

### Compositor Dockerfile (starting point)

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install requests --break-system-packages

COPY overlay_updater.py /app/overlay_updater.py
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV RTMP_INPUT=rtmp://rtmp:1935/live/stream
ENV TWITCH_URL=rtmp://live.twitch.tv/app/CHANGEME

ENTRYPOINT ["/entrypoint.sh"]
```

```bash
#!/bin/bash
# compositor entrypoint.sh

# Start the overlay text updater in background
python3 /app/overlay_updater.py &

# Wait for the source stream to be available
sleep 5

# Composite and push to Twitch
exec ffmpeg \
    -i "$RTMP_INPUT" \
    -vf "drawtext=textfile=/tmp/overlay.txt:reload=1:fontsize=20:fontcolor=white:x=10:y=10:box=1:boxcolor=black@0.7:boxborderw=8" \
    -c:v libx264 -preset fast -tune zerolatency -g 60 \
    -c:a aac -b:a 128k \
    -f flv "$TWITCH_URL"
```

---

## Twitch Restreaming

When the compositor pushes to Twitch, use the ingest server closest to wherever this runs. Twitch ingest endpoints:

- Auto: `rtmp://live.twitch.tv/app/{STREAM_KEY}`
- US West: `rtmp://live-lax.twitch.tv/app/{STREAM_KEY}`
- US East: `rtmp://live-iad.twitch.tv/app/{STREAM_KEY}`

Twitch requirements:

- Max bitrate: 6000 kbps recommended
- Keyframe interval: 2 seconds (so `-g 120` at 60fps, or `-g 60` at 30fps)
- Audio: AAC, 44100 Hz, 128 kbps stereo
- Video: H.264, yuv420p, High or Main profile

For a GBA game at 720x480, the bitrate will be very low (~1000-2000 kbps) since the visual complexity is minimal. Well within Twitch limits.

---

## Pokemon FireRed Memory Map

For the API server's `/state` endpoint. FireRed (US v1.0) uses Gen III's DMA-protected save block architecture, which is significantly more complex than the flat memory layout of Gen I/II games.

### CRITICAL CONCEPT: DMA-Protected Save Blocks

FireRed stores game state in three "save blocks" that get **randomly relocated in EWRAM** every time a warp is triggered or a menu is opened. You cannot hardcode their addresses. Instead, you read a **pointer** from a fixed IWRAM address, then add an offset to reach the actual data.

The three block pointers (these NEVER move):

| Pointer Address | Name | Contains |
|-----------------|------|----------|
| `0x03005008` | Save Block 1 | Map/world state, money, items, bag, flags, vars |
| `0x0300500C` | Save Block 2 | Trainer personal data (name, ID, gender, options, pokedex) |
| `0x03005010` | Save Block 3 | PC box pokemon and items |

**How to read data:** First read the pointer, then use that value as the base address and add the field offset. For example, to read the player's name:

```
1. READ_CORE_MEMORY 0300500C 4    → returns e.g. "02 00 3A 80" (little-endian)
2. Reassemble as little-endian: 0x02003A80
3. READ_CORE_MEMORY 02003A80 8    → returns the player name bytes
```

This two-step read is required for ALL save block data. Your API server must implement this pointer dereferencing.

### Save Block 2 — Trainer Data (pointer at `0x0300500C`)

| Offset | Size | Data |
|--------|------|------|
| `+0x0000` | 8 bytes | Player name (Gen III encoding, not ASCII, terminated by 0xFF) |
| `+0x0008` | 1 byte | Gender (0x00 = male, 0x01 = female) |
| `+0x000A` | 2 bytes | Trainer ID (visible one) |
| `+0x000C` | 2 bytes | Secret ID |
| `+0x000E` | 2 bytes | Play time (hours) |
| `+0x0010` | 1 byte | Play time (minutes) |
| `+0x0011` | 1 byte | Play time (seconds) |
| `+0x001A` | 1 byte | National Dex flag (0xDA = enabled) |
| `+0x0028` | 52 bytes | Pokedex caught flags (bitfield) |
| `+0x005C` | 52 bytes | Pokedex seen flags (bitfield) |
| `+0x0F20` | 4 bytes | Encryption key (XOR key for money/items) |

### Save Block 1 — Game State (pointer at `0x03005008`)

| Offset | Size | Data |
|--------|------|------|
| `+0x0000` | 2 bytes | Camera X position |
| `+0x0002` | 2 bytes | Camera Y position |
| `+0x0004` | 1 byte | Current map number |
| `+0x0005` | 1 byte | Current map bank |
| `+0x0034` | 1 byte | Party Pokemon count |
| `+0x0218` | 4 bytes | Money (XOR encrypted — see below) |
| `+0x0298` | varies | Bag items |

### Badges — Flag-Based System

Badges in FireRed are stored as **game flags**, not a simple bitmask byte. Flags are stored in Save Block 1's flags area. The badge flags are:

| Flag | Badge | Gym Leader |
|------|-------|------------|
| `0x820` | Boulder Badge | Brock |
| `0x821` | Cascade Badge | Misty |
| `0x822` | Thunder Badge | Lt. Surge |
| `0x823` | Rainbow Badge | Erika |
| `0x824` | Soul Badge | Koga |
| `+0x825` | Marsh Badge | Sabrina |
| `0x826` | Volcano Badge | Blaine |
| `0x827` | Earth Badge | Giovanni |

Flags are stored as a bitfield in Save Block 1. The flags region starts at offset `+0x0EE0` in Save Block 1. To check flag N:

```
byte_offset = 0x0EE0 + (flag_number / 8)
bit_position = flag_number % 8
flag_is_set = (byte_at_offset >> bit_position) & 1
```

So for badge flags 0x820–0x827:

```
byte_offset = 0x0EE0 + (0x820 / 8) = 0x0EE0 + 0x104 = 0x0FE4
```

All 8 badge flags fit in a single byte at Save Block 1 + `0x0FE4`. Bit 0 = Boulder, bit 1 = Cascade, ..., bit 7 = Earth.

### Other Useful Flags

| Flag | Purpose |
|------|---------|
| `0x828` | Pokemon Menu enabled |
| `0x829` | Pokedex enabled |
| `0x82F` | Running Shoes obtained |

### Party Pokemon — Fixed EWRAM Addresses

Unlike the save block data, the active party Pokemon in battle/overworld are at **fixed EWRAM addresses** (these do NOT move with DMA):

| Address | Size | Data |
|---------|------|------|
| `0x02024284` | 100 bytes | Party Pokemon 1 |
| `0x020242E8` | 100 bytes | Party Pokemon 2 |
| `0x0202434C` | 100 bytes | Party Pokemon 3 |
| `0x020243B0` | 100 bytes | Party Pokemon 4 |
| `0x02024414` | 100 bytes | Party Pokemon 5 |
| `0x02024478` | 100 bytes | Party Pokemon 6 |

Each 100-byte Pokemon structure (Gen III format):

| Offset | Size | Data |
|--------|------|------|
| `+0x00` | 4 bytes | Personality Value |
| `+0x04` | 4 bytes | OT ID |
| `+0x08` | 10 bytes | Nickname (Gen III encoding) |
| `+0x12` | 2 bytes | Language |
| `+0x14` | 7 bytes | OT Name |
| `+0x1B` | 1 byte | Markings |
| `+0x1C` | 2 bytes | Checksum |
| `+0x1E` | 2 bytes | Padding |
| `+0x20` | 48 bytes | **Encrypted data substructure** (see below) |
| `+0x50` | 4 bytes | Status condition |
| `+0x54` | 1 byte | Level |
| `+0x55` | 1 byte | Pokerus remaining |
| `+0x56` | 2 bytes | Current HP |
| `+0x58` | 2 bytes | Max HP |
| `+0x5A` | 2 bytes | Attack |
| `+0x5C` | 2 bytes | Defense |
| `+0x5E` | 2 bytes | Speed |
| `+0x60` | 2 bytes | Sp. Attack |
| `+0x62` | 2 bytes | Sp. Defense |

**Important:** The fields from offset `+0x50` onward (level, HP, stats) are **only present for party Pokemon**, not PC-stored ones. They are recalculated from the encrypted data when a Pokemon is withdrawn.

**The 48-byte encrypted data substructure** at `+0x20` contains species, held item, moves, EVs, IVs, etc. It is XOR-encrypted using the Pokemon's personality value and OT ID. The 48 bytes are divided into four 12-byte substructures whose ORDER is determined by `personality_value % 24`. Decrypting this is non-trivial — see Bulbapedia's "Pokemon data structure (Generation III)" for the full algorithm.

For quick state checking (badges, HP, level), you do NOT need to decrypt the substructure. Level, current HP, max HP, and stats are all unencrypted in the party structure.

### Money — XOR Encrypted

Money is stored at Save Block 1 + `0x0218` as a 4-byte little-endian integer, but it's XOR'd with the encryption key at Save Block 2 + `0x0F20`:

```python
def read_money(saveblock1_base, saveblock2_base):
    raw_money = read_u32(saveblock1_base + 0x0218)
    xor_key = read_u32(saveblock2_base + 0x0F20)
    return raw_money ^ xor_key
```

### Player Name Encoding

Gen III uses a proprietary character encoding, NOT ASCII. Common mappings:

```
0xBB='A', 0xBC='B', 0xBD='C', ..., 0xD4='Z'
0xD5='a', 0xD6='b', ..., 0xEE='z'
0xA1='0', 0xA2='1', ..., 0xAA='9'
0xFF=terminator
```

### Practical Python Example for Reading Game State

```python
import socket
import struct

def read_memory(address, length, host="emulator", port=55355):
    """Read bytes from emulator memory via RetroArch network commands."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2.0)
    cmd = f"READ_CORE_MEMORY {address:08X} {length}"
    sock.sendto(cmd.encode(), (host, port))
    try:
        data, _ = sock.recvfrom(65535)
        response = data.decode().strip()
        parts = response.split()
        if parts[0] == "READ_CORE_MEMORY" and len(parts) > 2:
            return bytes([int(b, 16) for b in parts[2:]])
        return None
    except socket.timeout:
        return None
    finally:
        sock.close()

def read_u32_le(data, offset=0):
    return struct.unpack_from('<I', data, offset)[0]

def read_u16_le(data, offset=0):
    return struct.unpack_from('<H', data, offset)[0]

def get_saveblock_pointers():
    """Read the DMA-protected save block base addresses."""
    sb1_ptr_data = read_memory(0x03005008, 4)
    sb2_ptr_data = read_memory(0x0300500C, 4)
    if sb1_ptr_data is None or sb2_ptr_data is None:
        return None, None
    sb1_base = read_u32_le(sb1_ptr_data)
    sb2_base = read_u32_le(sb2_ptr_data)
    return sb1_base, sb2_base

def get_badges():
    """Read badge flags. Returns dict of badge_name -> bool."""
    sb1_base, _ = get_saveblock_pointers()
    if sb1_base is None:
        return None
    # Badge flags 0x820-0x827 are at flags base + (0x820 / 8)
    # Flags start at SB1 + 0x0EE0
    badge_byte_data = read_memory(sb1_base + 0x0FE4, 1)
    if badge_byte_data is None:
        return None
    badge_byte = badge_byte_data[0]
    badges = [
        "Boulder", "Cascade", "Thunder", "Rainbow",
        "Soul", "Marsh", "Volcano", "Earth"
    ]
    return {name: bool(badge_byte & (1 << i)) for i, name in enumerate(badges)}

def get_party_summary():
    """Read party Pokemon summary (level, HP, species from fixed EWRAM)."""
    PARTY_BASE = 0x02024284
    PARTY_SIZE = 100
    party = []
    for i in range(6):
        addr = PARTY_BASE + (i * PARTY_SIZE)
        data = read_memory(addr, PARTY_SIZE)
        if data is None:
            break
        personality = read_u32_le(data, 0x00)
        if personality == 0:  # Empty slot
            break
        nickname_raw = data[0x08:0x12]
        level = data[0x54]
        current_hp = read_u16_le(data, 0x56)
        max_hp = read_u16_le(data, 0x58)
        party.append({
            "slot": i + 1,
            "level": level,
            "hp": current_hp,
            "max_hp": max_hp,
            "nickname_raw": nickname_raw.hex(),
        })
    return party

def get_player_position():
    """Read player map position from Save Block 1."""
    sb1_base, _ = get_saveblock_pointers()
    if sb1_base is None:
        return None
    pos_data = read_memory(sb1_base, 6)
    if pos_data is None:
        return None
    return {
        "x": read_u16_le(pos_data, 0),
        "y": read_u16_le(pos_data, 2),
        "map": pos_data[4],
        "bank": pos_data[5],
    }

def get_money():
    """Read money (XOR decrypted)."""
    sb1_base, sb2_base = get_saveblock_pointers()
    if sb1_base is None or sb2_base is None:
        return None
    money_data = read_memory(sb1_base + 0x0218, 4)
    key_data = read_memory(sb2_base + 0x0F20, 4)
    if money_data is None or key_data is None:
        return None
    raw = read_u32_le(money_data)
    key = read_u32_le(key_data)
    return raw ^ key
```

### Testing Memory Reads Manually

```bash
# Step 1: Read Save Block 1 pointer
echo -n "READ_CORE_MEMORY 03005008 4" | nc -u -w1 localhost 55355
# Example response: READ_CORE_MEMORY 03005008 80 3A 00 02
# Reassemble little-endian: 0x02003A80

# Step 2: Read badges at SB1 + 0x0FE4 (using base from step 1)
# 0x02003A80 + 0x0FE4 = 0x02004A64
echo -n "READ_CORE_MEMORY 02004A64 1" | nc -u -w1 localhost 55355
# Response byte: bit 0=Boulder, bit 1=Cascade, ..., bit 7=Earth

# Read party Pokemon 1 (fixed address — no pointer needed)
echo -n "READ_CORE_MEMORY 02024284 100" | nc -u -w1 localhost 55355

# Read party mon 1 level (offset +0x54 from party base)
# 0x02024284 + 0x54 = 0x020242D8
echo -n "READ_CORE_MEMORY 020242D8 1" | nc -u -w1 localhost 55355

# Read party mon 1 current HP (offset +0x56, 2 bytes little-endian)
echo -n "READ_CORE_MEMORY 020242DA 2" | nc -u -w1 localhost 55355
```

### Important Notes

- **All addresses are for Pokemon FireRed US v1.0.** Other versions (v1.1, JP, EU) will have different offsets.
- The **flags offset** (`0x0EE0`) within Save Block 1 should be verified empirically — set a badge in-game using a known save state and confirm the byte changes at the expected address.
- The **party addresses** (`0x02024284` etc.) are fixed EWRAM and do NOT move. These are the easiest and most reliable to read.
- **Save block pointers** at `0x03005008` / `0x0300500C` ARE stable (they're in IWRAM), but the values they point TO change frequently. Always re-read the pointer before accessing save block data.

---

## Testing Checklist

### Phase 1: Emulator (DONE)

- [x] Docker image builds on ARM64 (M1 Mac)
- [x] Xvfb starts successfully
- [x] RetroArch finds mGBA core
- [x] RetroArch loads a .gb ROM
- [x] RTMP stream is published to mediamtx
- [x] Stream is watchable with mpv
- [x] Audio and video both present in stream
- [x] Stream plays without excessive buffering

### Phase 2: Input + Memory (NOT YET TESTED)

- [ ] UDP input on port 55400 actually presses buttons in-game
- [ ] Test each button individually (A, B, Start, Select, directions)
- [ ] Test button combinations
- [ ] Test button release (sending 0)
- [ ] `READ_CORE_MEMORY` returns data on port 55355
- [ ] Read a known Pokemon Red memory address (e.g., badges at D356)
- [ ] Verify memory values change as the game progresses
- [ ] Test `SAVE_STATE` and `LOAD_STATE` commands

### Phase 3: API Server

- [ ] Vote endpoint accepts and tallies votes
- [ ] Vote window resolves correctly and sends winning input to emulator
- [ ] State endpoint reads and decodes Pokemon game state from RAM
- [ ] Screenshot endpoint captures a frame from the RTMP stream
- [ ] Votes endpoint returns current tally for the compositor

### Phase 4: Compositor

- [ ] FFmpeg can consume the raw RTMP stream as input
- [ ] Overlay text/image is composited on the gameplay video
- [ ] Overlay updates dynamically as votes change
- [ ] Final composited stream pushes to Twitch successfully
- [ ] Stream meets Twitch requirements (keyframe interval, codec, etc.)
- [ ] End-to-end latency is acceptable (< 5 seconds from input to viewer)

---

## Common Pitfalls and Gotchas

### Docker Networking

- Containers in the same docker-compose.yml can reach each other by service name. So the emulator pushes to `rtmp://rtmp:1935/live/stream` (using the service name `rtmp`), and the compositor reads from the same URL.
- Ports in `ports:` are for host access. Container-to-container communication uses the internal Docker network and doesn't need published ports.
- UDP ports must be explicitly marked as `/udp` in the compose file: `"55400:55400/udp"`.

### ARM64 vs x86_64

- The mGBA libretro core installs to different paths: `/usr/lib/aarch64-linux-gnu/libretro/` on ARM64, `/usr/lib/x86_64-linux-gnu/libretro/` on x86_64. The entrypoint uses `find` to handle this.
- The mediamtx image is multi-arch and works on both.
- The ubuntu:24.04 base image is multi-arch.
- No architecture-specific issues have been observed.

### RetroArch Weirdness in Docker

- `pause_nonactive = "false"` is mandatory. Without it, RetroArch pauses when the X11 window doesn't have focus, which in Xvfb means immediately.
- `video_driver = "null"` breaks `--record`. The recording pipeline needs actual rendered frames.
- `SDL_AUDIODRIVER=dummy` is fine — RetroArch captures audio before it reaches the driver, so recording still gets audio even though playback is muted.
- RetroArch's `--verbose` flag is essential for debugging. It prints every configuration decision, driver initialization, and error to stderr.

### RTMP Stream Timing

- mediamtx auto-creates stream paths. The emulator can start publishing to `rtmp://rtmp:1935/live/stream` at any time; mediamtx will accept it.
- If the emulator restarts, mediamtx may take a few seconds to clean up the old stream before accepting a new publish to the same path.
- If the compositor (FFmpeg consumer) starts before the emulator publishes, FFmpeg will fail to connect. The compositor entrypoint should retry or wait for the stream to appear.

### Memory Read Timing

- `READ_CORE_MEMORY` reads whatever is in memory at that exact instant. If the game is in the middle of a frame update, you might get partially-updated data.
- For Pokemon, this is rarely an issue because game state changes happen between frames. But if you're reading multi-byte values (like HP which is 2 bytes), there's a theoretical race. In practice, at 60fps with UDP round-trip times measured in milliseconds, this is not a real problem.

---

## File-by-File Reference

```
gba-stream/
├── docker-compose.yml          # Two services: rtmp (mediamtx) + emulator
├── README.md                   # Quick start for users
├── DEVELOPMENT_GUIDE.md        # This file
├── roms/                       # Mount point for ROM files (gitignored)
│   └── .gitkeep
└── emulator/
    ├── Dockerfile              # Ubuntu 24.04 + retroarch + mgba + xvfb + ffmpeg + dbus
    ├── entrypoint.sh           # Starts Xvfb, waits for RTMP, launches RetroArch
    ├── retroarch.cfg           # Headless config with network interfaces enabled
    └── recording.cfg           # FFmpeg encoding settings for RTMP streaming
```

### docker-compose.yml

Defines two services. The `emulator` service depends on `rtmp` and exposes UDP ports for future input/memory access. The `RTMP_URL` env var points at the `rtmp` service by Docker DNS name.

### emulator/Dockerfile

Installs all packages, copies configs and entrypoint. Nothing runs at build time — everything happens in the entrypoint at container start.

### emulator/entrypoint.sh

Sequential startup: Xvfb → wait for RTMP → find core → find ROM → dbus-launch → exec retroarch. Uses `exec` for the final command so RetroArch becomes PID 1 and handles signals correctly (important for clean shutdown with `docker compose down`).

### emulator/retroarch.cfg

Minimal config. Only sets what's necessary. RetroArch has hundreds of options; the defaults are fine for everything not listed. Key non-obvious setting: `video_gpu_screenshot = "false"` — forces software screenshots, which work reliably in Xvfb without GPU acceleration.

### emulator/recording.cfg

FFmpeg encoding parameters. The `scale_factor = 3` upscales GBA's native 240×160 to 720×480 before encoding. Increase to 4 for 960×640 if desired.
