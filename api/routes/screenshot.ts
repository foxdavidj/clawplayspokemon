/**
 * Screenshot routes for serving game screenshots.
 *
 * The Python emulator writes screenshots to SCREENSHOT_PATH on disk.
 * This route simply serves that file with ETag caching.
 */

import { Elysia } from "elysia";
import { getCurrentWindow, getScreenshotState } from "../state";

const SCREENSHOT_CACHE_TTL = parseInt(process.env.SCREENSHOT_CACHE_TTL || "5", 10);

export const screenshotRoutes = new Elysia({ name: "screenshot" })
  .get("/screenshot", ({ request, set }) => {
    const clientEtag = request.headers.get("if-none-match");
    const { data, etag } = getScreenshotState();
    const currentWindow = getCurrentWindow();

    if (clientEtag && clientEtag === `"${etag}"`) {
      set.status = 304;
      return;
    }

    if (!data) {
      set.status = 503;
      return { error: "Screenshot not available yet" };
    }

    set.headers["Content-Type"] = "image/png";
    set.headers["ETag"] = `"${etag}"`;
    set.headers["Cache-Control"] = `public, max-age=${SCREENSHOT_CACHE_TTL}`;
    set.headers["X-Window-Id"] = currentWindow.windowId.toString();
    set.headers["X-Time-Remaining-Ms"] = Math.max(0, currentWindow.endTime - Date.now()).toString();

    return new Response(data);
  }, {
    detail: {
      tags: ["Screenshot"],
      summary: "Get current game screenshot",
      description: `Returns a PNG screenshot (480x432). Cached for ${SCREENSHOT_CACHE_TTL} seconds. Use ETag caching with If-None-Match header to get 304 responses when nothing changed.`,
    },
  });
