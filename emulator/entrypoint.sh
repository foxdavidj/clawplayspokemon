#!/bin/bash
set -e

# --- Start virtual display ---
echo "Starting Xvfb..."
Xvfb :99 -screen 0 1024x768x24 +extension GLX &
XVFB_PID=$!
sleep 2

if ! kill -0 $XVFB_PID 2>/dev/null; then
    echo "ERROR: Xvfb failed to start"
    exit 1
fi
echo "Xvfb running on :99"

# --- Wait for RTMP server ---
echo "Waiting for RTMP server at rtmp:1935..."
TRIES=0
until nc -z rtmp 1935 2>/dev/null; do
    TRIES=$((TRIES + 1))
    if [ $TRIES -gt 30 ]; then
        echo "ERROR: RTMP server not reachable after 30s"
        exit 1
    fi
    sleep 1
done
echo "RTMP server ready"

# --- Find mGBA core ---
CORE=$(find /usr/lib -name "mgba_libretro.so" 2>/dev/null | head -1)
if [ -z "$CORE" ]; then
    echo "ERROR: mGBA libretro core not found"
    echo "Searched /usr/lib recursively for mgba_libretro.so"
    exit 1
fi
echo "Core: $CORE"

# --- Find ROM ---
if [ -n "$ROM_PATH" ] && [ -f "$ROM_PATH" ]; then
    echo "Using ROM from ROM_PATH: $ROM_PATH"
elif [ -n "$ROM_PATH" ] && [ -f "/roms/$ROM_PATH" ]; then
    ROM_PATH="/roms/$ROM_PATH"
    echo "Using ROM: $ROM_PATH"
else
    # Auto-detect: find first .gba, .gbc, or .gb file
    ROM_PATH=$(find /roms -maxdepth 1 \( -iname "*.gba" -o -iname "*.gbc" -o -iname "*.gb" \) | head -1)
    if [ -z "$ROM_PATH" ]; then
        echo "ERROR: No ROM found"
        echo "Put a .gba/.gbc/.gb file in the roms/ directory, or set ROM_PATH"
        echo "Contents of /roms/:"
        ls -la /roms/ 2>/dev/null || echo "  (directory not found)"
        exit 1
    fi
    echo "Auto-detected ROM: $ROM_PATH"
fi

# --- Check RetroArch recording support ---
echo ""
echo "=== RetroArch Build Info ==="
retroarch --features 2>&1 | head -20 || true
echo "==========================="
echo ""

# --- Start dbus session (RetroArch/GameMode needs this) ---
eval $(dbus-launch --sh-syntax)
echo "D-Bus session started"

# --- Start input server (xdotool-based button input via TCP) ---
echo "Starting input server on TCP port ${INPUT_PORT:-55400}..."
/input_server.sh &
INPUT_SERVER_PID=$!
sleep 1
if ! kill -0 $INPUT_SERVER_PID 2>/dev/null; then
    echo "WARNING: Input server may have failed to start"
else
    echo "Input server running (PID $INPUT_SERVER_PID)"
fi

# --- Launch RetroArch ---
echo "Launching RetroArch..."
echo "  Core:   $CORE"
echo "  ROM:    $ROM_PATH"
echo "  Stream: $RTMP_URL"
echo ""
echo "Watch with: mpv rtmp://localhost:1935/live/stream"
echo ""

exec retroarch \
    -L "$CORE" \
    "$ROM_PATH" \
    --record "$RTMP_URL" \
    --recordconfig /root/.config/retroarch/recording.cfg \
    --verbose
