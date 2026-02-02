FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    retroarch \
    libretro-mgba \
    xvfb \
    ffmpeg \
    netcat-openbsd \
    dbus-x11 \
    xdotool \
    && rm -rf /var/lib/apt/lists/*

# Create retroarch config directory
RUN mkdir -p /root/.config/retroarch

COPY retroarch.cfg /root/.config/retroarch/retroarch.cfg
COPY recording.cfg /root/.config/retroarch/recording.cfg
COPY entrypoint.sh /entrypoint.sh
COPY input_server.sh /input_server.sh
RUN chmod +x /entrypoint.sh /input_server.sh

ENTRYPOINT ["/entrypoint.sh"]
