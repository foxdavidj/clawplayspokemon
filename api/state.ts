/**
 * Shared state management for the Claw Plays Pokemon voting system.
 *
 * This module contains:
 * - Voting window state and management
 * - Screenshot state (fetched from RTMP stream)
 * - Game state (fetched from emulator RAM via UDP)
 */

import type { VotingWindow, Vote, VoteTally, ExecutionResult, Button, GameState } from "./types";
import { VALID_BUTTONS } from "./types";
import { pressButton } from "./services/emulator";
import { fetchGameState } from "./services/gamestate";
import { captureScreenshot } from "./services/screenshot";

// Configuration
const WINDOW_DURATION_MS = parseInt(process.env.VOTE_WINDOW_DURATION_MS || "10000", 10);
const SCREENSHOT_FETCH_INTERVAL_MS = parseInt(process.env.SCREENSHOT_FETCH_INTERVAL_MS || "5000", 10);
const GAMESTATE_FETCH_INTERVAL_MS = parseInt(process.env.GAMESTATE_FETCH_INTERVAL_MS || "3000", 10);

// ============================================================================
// Voting State
// ============================================================================

let currentWindow: VotingWindow = createNewWindow();
let previousResults: ExecutionResult | null = null;

export function createNewWindow(): VotingWindow {
  const now = Date.now();
  return {
    windowId: Math.floor(now / WINDOW_DURATION_MS),
    startTime: now,
    endTime: now + WINDOW_DURATION_MS,
    votes: new Map(),
    executed: false,
  };
}

export function getCurrentWindow(): VotingWindow {
  return currentWindow;
}

export function getPreviousResults(): ExecutionResult | null {
  return previousResults;
}

export function tallyVotes(window: VotingWindow): VoteTally[] {
  const counts = new Map<Button, { count: number; voters: string[] }>();

  // Initialize all buttons
  for (const btn of VALID_BUTTONS) {
    counts.set(btn, { count: 0, voters: [] });
  }

  // Count votes
  for (const vote of window.votes.values()) {
    const tally = counts.get(vote.button)!;
    tally.count++;
    tally.voters.push(vote.agentName);
  }

  // Convert to sorted array
  const totalVotes = window.votes.size || 1;
  return Array.from(counts.entries())
    .map(([button, { count, voters }]) => ({
      button,
      count,
      percentage: Math.round((count / totalVotes) * 100),
      voters,
    }))
    .sort((a, b) => b.count - a.count);
}

export function executeWindow(window: VotingWindow): ExecutionResult {
  const tallies = tallyVotes(window);
  const maxVotes = tallies[0]?.count ?? 0;
  const topVotes = tallies.filter((t) => t.count === maxVotes && t.count > 0);

  let winner: Button | null = null;
  if (topVotes.length > 0) {
    // Random tiebreaker
    const randomIndex = Math.floor(Math.random() * topVotes.length);
    winner = topVotes[randomIndex]?.button ?? null;
    if (winner) {
      console.log(`Executing button: ${winner}`);
    }
  }

  return {
    windowId: window.windowId,
    winner,
    totalVotes: window.votes.size,
    tallies,
    executedAt: Date.now(),
  };
}

export function addVote(ip: string, vote: Vote): { isChange: boolean; existingVote?: Vote } {
  const existingVote = currentWindow.votes.get(ip);
  const isChange = existingVote !== undefined;
  currentWindow.votes.set(ip, vote);
  return { isChange, existingVote };
}

// Window management loop - executes winning button and sends to emulator
setInterval(async () => {
  const now = Date.now();
  if (now >= currentWindow.endTime && !currentWindow.executed) {
    currentWindow.executed = true;
    previousResults = executeWindow(currentWindow);

    // Send winning button to emulator via UDP
    if (previousResults.winner) {
      try {
        await pressButton(previousResults.winner);
      } catch (err) {
        console.error("Failed to send button to emulator:", err);
      }
    }

    currentWindow = createNewWindow();
    console.log(
      `Window ${previousResults.windowId} executed: ${previousResults.winner || "no votes"}`
    );
  }
}, 100);

// ============================================================================
// Screenshot State (fetched from RTMP stream via ffmpeg)
// ============================================================================

let currentScreenshot: Buffer | null = null;
let screenshotEtag: string = "";
let screenshotLastModified: number = 0;

export function getScreenshotState() {
  return {
    data: currentScreenshot,
    etag: screenshotEtag,
    lastModified: screenshotLastModified,
  };
}

// Screenshot polling loop - capture from RTMP stream
async function updateScreenshot(): Promise<void> {
  try {
    const screenshot = await captureScreenshot();
    if (screenshot) {
      currentScreenshot = screenshot;
      screenshotLastModified = Date.now();
      screenshotEtag = `${screenshotLastModified}-${screenshot.length}`;
    }
  } catch (err) {
    console.error("Failed to capture screenshot:", err);
  }
}

setInterval(updateScreenshot, SCREENSHOT_FETCH_INTERVAL_MS);

// Initial screenshot capture (delayed to allow emulator to start)
setTimeout(updateScreenshot, 5000);

// ============================================================================
// Game State (fetched from emulator RAM via UDP)
// ============================================================================

let currentGameState: GameState | null = null;

export function getGameState(): GameState | null {
  return currentGameState;
}

// Game state polling loop - read from emulator memory
async function updateGameState(): Promise<void> {
  try {
    const state = await fetchGameState();
    if (state) {
      currentGameState = state;
    }
  } catch (err) {
    console.error("Failed to fetch game state:", err);
  }
}

setInterval(updateGameState, GAMESTATE_FETCH_INTERVAL_MS);

// Initial game state fetch (delayed to allow emulator to start)
setTimeout(updateGameState, 5000);
