FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install all apt packages in one layer, clean up at the end
RUN apt-get update && \
    apt-get install -y software-properties-common && \
    add-apt-repository -y ppa:libretro/stable && \
    apt-get update && \
    apt-get install -y \
        retroarch \
        xvfb \
        ffmpeg \
        netcat-openbsd \
        dbus-x11 \
        xdotool \
        wget \
        unzip \
        libgl1 \
        libgl1-mesa-dri \
        libegl1 \
        libglx-mesa0 \
        mesa-utils \
    && rm -rf /var/lib/apt/lists/*

# Install mGBA core from libretro buildbot (latest nightly)
RUN wget -O /tmp/mgba.zip "https://buildbot.libretro.com/nightly/linux/x86_64/latest/mgba_libretro.so.zip" && \
    mkdir -p /usr/lib/libretro && \
    unzip -o /tmp/mgba.zip -d /usr/lib/libretro/ && \
    rm /tmp/mgba.zip

# Create retroarch config directory
RUN mkdir -p /root/.config/retroarch

COPY retroarch.cfg /root/.config/retroarch/retroarch.cfg
COPY recording.cfg /root/.config/retroarch/recording.cfg
COPY entrypoint.sh /entrypoint.sh
COPY input_server.sh /input_server.sh
RUN chmod +x /entrypoint.sh /input_server.sh

ENTRYPOINT ["/entrypoint.sh"]
