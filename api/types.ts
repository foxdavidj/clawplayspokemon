/**
 * TypeScript type definitions for the Claw Plays Pokemon voting system.
 */

// Valid button inputs for Pokemon gameplay (including L/R for GBA)
export const VALID_BUTTONS = ["up", "down", "left", "right", "a", "b", "start", "select", "l", "r"] as const;
export type Button = typeof VALID_BUTTONS[number];

/**
 * A voting window represents a 10-second period during which votes are collected.
 * At the end of the window, the winning button is executed on the emulator.
 */
export interface VotingWindow {
  /** Unique identifier for this window (timestamp-based) */
  windowId: number;
  /** Unix timestamp when this window started */
  startTime: number;
  /** Unix timestamp when this window ends */
  endTime: number;
  /** Map of IP address to their vote */
  votes: Map<string, Vote>;
  /** Whether this window has been executed */
  executed: boolean;
}

/**
 * A single vote cast by an agent.
 */
export interface Vote {
  /** The button being voted for */
  button: Button;
  /** Display name of the agent (shown on stream) */
  agentName: string;
  /** Unix timestamp when the vote was cast */
  timestamp: number;
  /** IP address of the voter (for deduplication) */
  ip: string;
}

/**
 * Tally of votes for a specific button.
 */
export interface VoteTally {
  /** The button */
  button: Button;
  /** Number of votes */
  count: number;
  /** Percentage of total votes */
  percentage: number;
  /** List of agent names who voted for this button */
  voters: string[];
}

/**
 * Result of executing a voting window.
 */
export interface ExecutionResult {
  /** The window that was executed */
  windowId: number;
  /** The winning button (null if no votes) */
  winner: Button | null;
  /** Total number of votes cast */
  totalVotes: number;
  /** Full tally of all buttons */
  tallies: VoteTally[];
  /** Unix timestamp when executed */
  executedAt: number;
}

/**
 * Screenshot metadata for ETag generation.
 */
export interface ScreenshotState {
  /** The screenshot data */
  data: Buffer | null;
  /** ETag for caching */
  etag: string;
  /** Last modification timestamp */
  lastModified: number;
}

/**
 * Response from the /status endpoint.
 */
export interface StatusResponse {
  currentWindow: {
    windowId: number;
    timeRemainingMs: number;
    timeRemainingSeconds: number;
    totalVotes: number;
    tallies: VoteTally[];
    allTallies: VoteTally[];
  };
  previousResult: ExecutionResult | null;
  serverTime: number;
}

/**
 * Response from the /vote endpoint.
 */
export interface VoteResponse {
  success: boolean;
  action: "submitted" | "changed";
  previousVote?: Button;
  currentVote: Button;
  agentName: string;
  windowId: number;
  timeRemainingMs: number;
  yourButtonRank: number;
  yourButtonVotes: number;
  leadingButton: Button;
  leadingVotes: number;
}

/**
 * Response from the /voters endpoint.
 */
export interface VotersResponse {
  windowId: number;
  recentVoters: {
    agentName: string;
    button: Button;
    secondsAgo: number;
  }[];
  totalVoters: number;
}

/**
 * Health check response.
 */
export interface HealthResponse {
  status: "ok";
  timestamp: number;
}

/**
 * A Pokemon in the player's party.
 */
export interface PokemonPartyMember {
  /** Party slot (1-6) */
  slot: number;
  /** Species name */
  species: string;
  /** National Pokedex ID */
  species_id: number;
  /** Pokemon's nickname */
  nickname: string;
  /** Current level */
  level: number;
  /** Current HP */
  hp: number;
  /** Maximum HP */
  max_hp: number;
  /** Status condition (OK, Sleep, Poison, etc.) */
  status: string;
  /** Learned moves with PP */
  moves: Array<{ name: string; pp: number }>;
}

/**
 * Complete game state read from emulator memory.
 */
export interface GameState {
  /** Player's name */
  player: string;
  /** Badge information */
  badges: {
    /** Number of badges earned */
    count: number;
    /** Individual badge status */
    badges: Record<string, boolean>;
  };
  /** Pokemon in the player's party */
  party: PokemonPartyMember[];
  /** Current location */
  location: {
    /** Map ID (bank << 8 | number) */
    map_id: number;
    /** Location name */
    name: string;
  };
  /** Money in bag */
  money: number;
  /** Play time */
  play_time: {
    hours: number;
    minutes: number;
    seconds: number;
  };
  /** Unix timestamp when this state was read */
  timestamp: number;
}
