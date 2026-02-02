/**
 * Screenshot capture service.
 *
 * Captures single frames from the RTMP stream using ffmpeg.
 */

const RTMP_URL = process.env.RTMP_URL || "rtmp://rtmp:1935/live/stream";
const SCREENSHOT_TIMEOUT_MS = parseInt(process.env.SCREENSHOT_TIMEOUT_MS || "10000", 10);

/**
 * Capture a screenshot from the RTMP stream.
 *
 * Uses ffmpeg to grab a single frame and encode it as PNG.
 * Returns null if capture fails (e.g., stream not available).
 */
export async function captureScreenshot(): Promise<Buffer | null> {
  try {
    // Use Bun's shell to run ffmpeg
    // -i: Input from RTMP stream
    // -frames:v 1: Capture only 1 frame
    // -f image2pipe: Output as raw image to pipe
    // -vcodec png: Encode as PNG
    // pipe:1: Write to stdout
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-y", // Overwrite output files without asking
        "-loglevel", "error", // Suppress verbose output
        "-i", RTMP_URL,
        "-frames:v", "1",
        "-f", "image2pipe",
        "-vcodec", "png",
        "pipe:1",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Set up timeout
    const timeoutId = setTimeout(() => {
      proc.kill();
    }, SCREENSHOT_TIMEOUT_MS);

    // Wait for process to complete
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error("ffmpeg screenshot failed:", stderr.slice(0, 200));
      return null;
    }

    // Read stdout as buffer
    const chunks: Uint8Array[] = [];
    const reader = proc.stdout.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    if (chunks.length === 0) {
      console.error("ffmpeg produced no output");
      return null;
    }

    // Combine chunks into single buffer
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return Buffer.from(result);
  } catch (err) {
    console.error("Screenshot capture error:", err);
    return null;
  }
}
