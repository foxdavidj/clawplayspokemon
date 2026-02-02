FROM oven/bun:1-alpine

WORKDIR /app

# Install ffmpeg for screenshot capture, netcat for input commands
RUN apk add --no-cache ffmpeg netcat-openbsd

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY . .

# Expose API port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["bun", "run", "index.ts"]
