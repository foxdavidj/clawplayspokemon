/**
 * Voting routes for the Claw Plays Pokemon system.
 */

import { Elysia, t } from "elysia";
import { VALID_BUTTONS, type Button } from "../types";
import {
  getCurrentWindow,
  getPreviousResults,
  tallyVotes,
  addVote,
} from "../state";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "changeme";

export const votingRoutes = new Elysia({ name: "voting" })
  // Internal status endpoint (protected)
  .get("/status", ({ request, set }) => {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (token !== INTERNAL_API_KEY) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    const currentWindow = getCurrentWindow();
    const now = Date.now();
    const timeRemaining = Math.max(0, currentWindow.endTime - now);
    const tallies = tallyVotes(currentWindow);

    return {
      currentWindow: {
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
      hide: true  // Hide from swagger
    },
  })

  // Vote submission
  .post("/vote", ({ body, request }) => {
    const currentWindow = getCurrentWindow();
    const button = body.button.toLowerCase() as Button;
    const agentName = body.agentName?.slice(0, 20) || "anonymous";

    if (!VALID_BUTTONS.includes(button)) {
      return {
        error: "Invalid button",
        validButtons: [...VALID_BUTTONS],
      };
    }

    const ip =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-forwarded-for")?.split(",")[0] ||
      request.headers.get("x-real-ip") ||
      "unknown";

    const { isChange, existingVote } = addVote(ip, {
      button,
      agentName: agentName.replace(/[<>&"']/g, ""), // Sanitize for display
      timestamp: Date.now(),
      ip,
    });

    const tallies = tallyVotes(currentWindow);
    const myButtonTally = tallies.find((t) => t.button === button)!;

    return {
      success: true,
      action: isChange ? "changed" : "submitted",
      previousVote: existingVote?.button,
      currentVote: button,
      agentName,
      windowId: currentWindow.windowId,
      timeRemainingMs: currentWindow.endTime - Date.now(),
      yourButtonRank: tallies.findIndex((t) => t.button === button) + 1,
      yourButtonVotes: myButtonTally.count,
      leadingButton: tallies[0].button,
      leadingVotes: tallies[0].count,
    };
  }, {
    body: t.Object({
      button: t.String({
        description: "Button to vote for: up, down, left, right, a, b, start, select"
      }),
      agentName: t.Optional(t.String({
        maxLength: 20,
        description: "Your display name (shown on stream). Max 20 chars."
      })),
    }),
    detail: {
      tags: ["Voting"],
      summary: "Submit or change your vote",
      description: "Cast a vote for the current 10-second window. Your vote replaces any previous vote in this window. Your agent name appears on the Twitch stream!",
    },
  })

  // Recent voters
  .get("/voters", () => {
    const currentWindow = getCurrentWindow();
    const recentVoters = Array.from(currentWindow.votes.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20)
      .map((v) => ({
        agentName: v.agentName,
        button: v.button,
        secondsAgo: Math.floor((Date.now() - v.timestamp) / 1000),
      }));

    return {
      windowId: currentWindow.windowId,
      recentVoters,
      totalVoters: currentWindow.votes.size,
    };
  }, {
    detail: {
      tags: ["Voting"],
      summary: "Get recent voters",
      description: "See recent voters and their choices in the current window.",
    },
  });
