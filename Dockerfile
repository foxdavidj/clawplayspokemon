# Claw Plays Pokemon
# Multi-stage Docker build for Bun/Elysia API + Python emulator

# =============================================================================
# Stage 1: Build Bun dependencies
# =============================================================================
FROM oven/bun:1-debian AS bun-builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# =============================================================================
# Stage 2: Final runtime image
# =============================================================================
FROM python:3.12-slim-bookworm AS runtime

# Prevent Python from writing pyc files and buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # FFmpeg for streaming
    ffmpeg \
    # Fonts for overlay rendering
    fonts-dejavu-core \
    # Process manager
    supervisor \
    # Health check utilities
    curl \
    # SDL2 for PyBoy (headless mode still needs base libs)
    libsdl2-2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy Bun binary from builder stage
COPY --from=bun-builder /usr/local/bin/bun /usr/local/bin/bun

# Copy Bun dependencies from builder
COPY --from=bun-builder /app/node_modules ./node_modules

# Install Python dependencies
COPY python/requirements.txt ./python/
RUN pip install --no-cache-dir -r python/requirements.txt

# Copy application source
COPY src/ ./src/
COPY python/ ./python/
COPY assets/ ./assets/
COPY package.json tsconfig.json ./

# Create data directory for persistent storage
RUN mkdir -p /app/data /app/roms

# Copy supervisord configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Copy health check script
COPY docker-healthcheck.sh /usr/local/bin/healthcheck
RUN chmod +x /usr/local/bin/healthcheck

# Environment variables with defaults
ENV ROM_PATH=/app/roms/pokemon_blue.gb \
    SCREENSHOT_PATH=/app/data/screenshot.png \
    SAVE_STATE_PATH=/app/data/pokemon.save \
    LOCAL_PREVIEW_PATH=/app/data/preview.png \
    API_PORT=3000 \
    API_URL=http://localhost:3000 \
    INTERNAL_API_KEY=changeme \
    RTMP_URL="" \
    LOCAL_PREVIEW=true \
    AUDIO_VOLUME_BOOST=10.0 \
    SAVE_STATE_INTERVAL=300 \
    VOTE_WINDOW_DURATION_MS=10000 \
    SCREENSHOT_CACHE_TTL=5

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD /usr/local/bin/healthcheck

# Graceful shutdown timeout (allow save state to complete)
STOPSIGNAL SIGTERM

# Start supervisord to manage both processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
