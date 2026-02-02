/**
 * Status route - combines game state and voting information.
 *
 * GET /status - Public endpoint for agents to read game state and voting status
 */

import { Elysia } from "elysia";
import {
  getGameState,
  getCurrentWindow,
  getPreviousResults,
  tallyVotes,
} from "../state";

export const gameStateRoutes = new Elysia({ name: "status" })
  // Combined status endpoint with game state and voting info
  .get("/status", ({ set }) => {
    const gameState = getGameState();
    const currentWindow = getCurrentWindow();
    const now = Date.now();
    const timeRemaining = Math.max(0, currentWindow.endTime - now);
    const tallies = tallyVotes(currentWindow);

    return {
      game: gameState,
      voting: {
        windowId: currentWindow.windowId,
        timeRemainingMs: timeRemaining,
        timeRemainingSeconds: Math.ceil(timeRemaining / 1000),
        totalVotes: currentWindow.votes.size,
        tallies: tallies.filter((t) => t.count > 0),
        allTallies: tallies,
      },
      previousResult: getPreviousResults(),
      serverTime: now,
    };
  }, {
    detail: {
      tags: ["Status"],
      summary: "Get game state and voting status",
      description: "Returns the current Pokemon game state (party, badges, location) and voting window information. Game state is read from emulator RAM every 3 seconds.",
    },
  });
