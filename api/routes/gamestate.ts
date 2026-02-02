/**
 * Status route - combines game state and voting information.
 *
 * GET /status - Public endpoint for compositor and agents
 */

import { Elysia } from "elysia";
import {
  getGameState,
  getCurrentWindow,
  getPreviousResults,
  tallyVotes,
  isInCooldown,
  getCooldownRemaining,
} from "../state";

export const gameStateRoutes = new Elysia({ name: "status" })
  // Combined status endpoint with game state and voting info
  .get("/status", () => {
    const gameState = getGameState();
    const currentWindow = getCurrentWindow();
    const now = Date.now();
    const timeRemaining = Math.max(0, currentWindow.endTime - now);
    const tallies = tallyVotes(currentWindow);

    // Get 10 most recent voters (newest first)
    const recentVoters = Array.from(currentWindow.votes.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 10)
      .map((v) => ({
        name: v.agentName,
        button: v.button,
        secondsAgo: Math.floor((now - v.timestamp) / 1000),
      }));

    // Get last executed result
    const previous = getPreviousResults();
    const lastResult = previous ? {
      winner: previous.winner,
      totalVotes: previous.totalVotes,
    } : null;

    const cooldown = isInCooldown();

    return {
      game: gameState,
      voting: {
        windowId: currentWindow.windowId,
        timeRemainingMs: timeRemaining,
        timeRemainingSeconds: Math.floor(timeRemaining / 1000),
        totalVotes: currentWindow.votes.size,
        tallies: tallies.filter((t) => t.count > 0),
        recentVoters,
        lastResult,
        cooldown: cooldown ? {
          active: true,
          remainingMs: getCooldownRemaining(),
        } : null,
      },
      serverTime: now,
    };
  }, {
    detail: {
      tags: ["Status"],
      summary: "Get game state and voting status",
      description: "Returns the current Pokemon game state (party, badges, location) and voting window information including recent voters.",
    },
  });
