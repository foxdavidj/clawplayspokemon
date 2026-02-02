/**
 * Health check routes.
 */

import { Elysia } from "elysia";

export const healthRoutes = new Elysia({ name: "health" })
  .get("/health", () => ({
    status: "ok" as const,
    timestamp: Date.now(),
  }), {
    detail: {
      tags: ["Health"],
      summary: "Health check",
      description: "Returns server health status",
    },
  });
