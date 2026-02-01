#!/bin/sh
# Health check script for Claw Plays Pokemon container
# Checks both API health and emulator activity

set -e

# Check 1: API is responding
API_HEALTH=$(curl -sf http://localhost:${API_PORT:-3000}/health || echo "failed")
if [ "$API_HEALTH" = "failed" ]; then
    echo "API health check failed"
    exit 1
fi

# Check 2: Screenshot file exists and was modified recently (within last 60 seconds)
# This indicates the emulator is running and producing frames
SCREENSHOT_PATH="${SCREENSHOT_PATH:-/app/data/screenshot.png}"
if [ -f "$SCREENSHOT_PATH" ]; then
    # Get file modification time in seconds since epoch
    FILE_MOD_TIME=$(stat -c %Y "$SCREENSHOT_PATH" 2>/dev/null || stat -f %m "$SCREENSHOT_PATH" 2>/dev/null)
    CURRENT_TIME=$(date +%s)
    AGE=$((CURRENT_TIME - FILE_MOD_TIME))

    if [ $AGE -gt 60 ]; then
        echo "Screenshot is stale (${AGE}s old)"
        exit 1
    fi
else
    # Screenshot doesn't exist yet - might be starting up
    # Check if we're within the startup grace period by looking at emulator process
    if pgrep -f "python.*main.py" > /dev/null; then
        echo "Emulator running but no screenshot yet (startup)"
        exit 0
    else
        echo "Screenshot missing and emulator not running"
        exit 1
    fi
fi

echo "Health check passed"
exit 0
