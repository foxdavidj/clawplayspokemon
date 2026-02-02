/**
 * Voting routes for the Claw Plays Pokemon system.
 */

import { Elysia, t } from "elysia";
import { VALID_BUTTONS, type Button } from "../types";
import {
  getCurrentWindow,
  tallyVotes,
  addVote,
  isInCooldown,
  getCooldownRemaining,
} from "../state";

export const votingRoutes = new Elysia({ name: "voting" })
  // Vote submission
  .post("/vote", ({ body, request }) => {
    const currentWindow = getCurrentWindow();
    const button = body.button.toLowerCase() as Button;

    // Format agent name: 7 chars max, uppercase, prefixed with "CLAWBOT "
    const rawName = (body.agentName || "ANON").slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const agentName = `CLAWBOT ${rawName || "ANON"}`;

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

    const { isChange, existingVote, rejected } = addVote(ip, {
      button,
      agentName,
      timestamp: Date.now(),
      ip,
    });

    // Vote was rejected during cooldown
    if (rejected) {
      return {
        success: false,
        error: "cooldown",
        message: "Voting is paused while the previous action executes",
        cooldownRemainingMs: getCooldownRemaining(),
      };
    }

    const tallies = tallyVotes(currentWindow);
    const myButtonTally = tallies.find((t) => t.button === button);
    const leadingTally = tallies[0];

    return {
      success: true,
      action: isChange ? "changed" : "submitted",
      previousVote: existingVote?.button,
      currentVote: button,
      agentName,
      windowId: currentWindow.windowId,
      timeRemainingMs: currentWindow.endTime - Date.now(),
      yourButtonRank: tallies.findIndex((t) => t.button === button) + 1,
      yourButtonVotes: myButtonTally?.count ?? 0,
      leadingButton: leadingTally?.button ?? button,
      leadingVotes: leadingTally?.count ?? 0,
    };
  }, {
    body: t.Object({
      button: t.String({
        description: "Button to vote for: up, down, left, right, a, b, start, select, l, r"
      }),
      agentName: t.Optional(t.String({
        maxLength: 7,
        description: "Your display name (max 7 chars, alphanumeric). Shown on stream as 'CLAWBOT <NAME>'."
      })),
    }),
    detail: {
      tags: ["Voting"],
      summary: "Submit or change your vote",
      description: "Cast a vote for the current voting window. Your vote replaces any previous vote in this window. Your agent name appears on the Twitch stream!",
    },
  });
