#!/bin/bash
# input_server.sh - listens on TCP 55400 and translates to xdotool keypresses
#
# Protocol:
#   PRESS <button>           - tap a button
#   HOLD <button> <ms>       - hold button for N milliseconds
#   DOWN <button>            - press and hold
#   UP <button>              - release
#
# Buttons: A, B, START, SELECT, UP, DOWN, LEFT, RIGHT, L, R

# RetroArch default keyboard mappings
declare -A BUTTON_MAP
BUTTON_MAP[A]="x"
BUTTON_MAP[B]="z"
BUTTON_MAP[START]="Return"
BUTTON_MAP[SELECT]="shift"
BUTTON_MAP[UP]="Up"
BUTTON_MAP[DOWN]="Down"
BUTTON_MAP[LEFT]="Left"
BUTTON_MAP[RIGHT]="Right"
BUTTON_MAP[L]="q"
BUTTON_MAP[R]="w"

INPUT_PORT="${INPUT_PORT:-55400}"

echo "Input server starting on TCP port $INPUT_PORT"

while true; do
    # Listen for connections and process commands
    nc -l -p "$INPUT_PORT" -q 1 | while IFS= read -r line; do
        # Skip empty lines
        [ -z "$line" ] && continue

        # Parse command
        cmd=$(echo "$line" | awk '{print toupper($1)}')
        button=$(echo "$line" | awk '{print toupper($2)}')
        duration=$(echo "$line" | awk '{print $3}')

        # Map button name to xdotool key
        key="${BUTTON_MAP[$button]}"

        if [ -z "$key" ]; then
            echo "Unknown button: $button"
            continue
        fi

        case "$cmd" in
            PRESS|TAP)
                echo "Pressing $button (key: $key)"
                DISPLAY=:99 xdotool keydown "$key"
                sleep 0.2
                DISPLAY=:99 xdotool keyup "$key"
                ;;
            HOLD)
                duration=${duration:-500}
                echo "Holding $button for ${duration}ms"
                DISPLAY=:99 xdotool keydown "$key"
                sleep "$(awk "BEGIN{printf \"%.3f\", $duration/1000}")"
                DISPLAY=:99 xdotool keyup "$key"
                ;;
            DOWN)
                echo "Key down: $button"
                DISPLAY=:99 xdotool keydown "$key"
                ;;
            UP)
                echo "Key up: $button"
                DISPLAY=:99 xdotool keyup "$key"
                ;;
            *)
                echo "Unknown command: $cmd"
                ;;
        esac
    done

    # Small delay before restarting listener
    sleep 0.1
done
