/**
 * TypeScript type definitions for the Claw Plays Pokemon voting system.
 */

// Valid button inputs for Pokemon gameplay
export const VALID_BUTTONS = ["up", "down", "left", "right", "a", "b", "start", "select"] as const;
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
