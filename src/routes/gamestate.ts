/**
 * Game state routes.
 *
 * - POST /internal/gamestate - Protected endpoint for emulator to push state
 * - GET /gamestate - Public endpoint for agents to read state
 */

import { Elysia, t } from "elysia";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "changeme";

// In-memory game state (updated by Python emulator)
let currentGameState: GameState | null = null;

interface GameState {
  player: string;
  badges: {
    count: number;
    badges: Record<string, boolean>;
  };
  party: Array<{
    slot: number;
    species: string;
    species_id: number;
    nickname: string;
    level: number;
    hp: number;
    max_hp: number;
    status: string;
    moves: Array<{
      name: string;
      pp: number;
    }>;
  }>;
  location: {
    map_id: number;
    name: string;
  };
  money: number;
  play_time: {
    hours: number;
    minutes: number;
    seconds: number;
  };
  timestamp: number;
}

export const gameStateRoutes = new Elysia({ name: "gamestate" })
  // Internal endpoint for emulator to push state (protected)
  .post("/internal/gamestate", ({ body, request, set }) => {
    const authHeader = request.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "");

    if (token !== INTERNAL_API_KEY) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    currentGameState = body as GameState;
    return { success: true };
  }, {
    body: t.Object({
      player: t.String(),
      badges: t.Object({
        count: t.Number(),
        badges: t.Record(t.String(), t.Boolean())
      }),
      party: t.Array(t.Object({
        slot: t.Number(),
        species: t.String(),
        species_id: t.Number(),
        nickname: t.String(),
        level: t.Number(),
        hp: t.Number(),
        max_hp: t.Number(),
        status: t.String(),
        moves: t.Array(t.Object({
          name: t.String(),
          pp: t.Number()
        }))
      })),
      location: t.Object({
        map_id: t.Number(),
        name: t.String()
      }),
      money: t.Number(),
      play_time: t.Object({
        hours: t.Number(),
        minutes: t.Number(),
        seconds: t.Number()
      }),
      timestamp: t.Number()
    }),
    detail: {
      hide: true  // Hide from swagger
    }
  })

  // Public endpoint for agents to read state
  .get("/gamestate", ({ set }) => {
    if (!currentGameState) {
      set.status = 503;
      return { error: "Game state not available yet" };
    }

    return currentGameState;
  }, {
    detail: {
      tags: ["Game State"],
      summary: "Get current game state",
      description: "Returns the current Pokemon party, badges, location, and other game information. Updated every 5 seconds.",
    }
  });
