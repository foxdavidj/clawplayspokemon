/**
 * Shared state management for the Claw Plays Pokemon voting system.
 *
 * This module contains all the voting window state and screenshot state
 * that is shared across route handlers.
 */

import type { VotingWindow, Vote, VoteTally, ExecutionResult, Button } from "./types";
import { VALID_BUTTONS } from "./types";

// Configuration
const WINDOW_DURATION_MS = parseInt(process.env.VOTE_WINDOW_DURATION_MS || "10000", 10);
const SCREENSHOT_PATH = process.env.SCREENSHOT_PATH || "./data/screenshot.png";

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
  const topVotes = tallies.filter((t) => t.count === tallies[0].count && t.count > 0);

  let winner: Button | null = null;
  if (topVotes.length > 0) {
    // Random tiebreaker
    winner = topVotes[Math.floor(Math.random() * topVotes.length)].button;
    console.log(`Executing button: ${winner}`);
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

// Window management loop
setInterval(() => {
  const now = Date.now();
  if (now >= currentWindow.endTime && !currentWindow.executed) {
    currentWindow.executed = true;
    previousResults = executeWindow(currentWindow);
    currentWindow = createNewWindow();
    console.log(
      `Window ${previousResults.windowId} executed: ${previousResults.winner || "no votes"}`
    );
  }
}, 100);

// ============================================================================
// Screenshot State
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

// Load screenshot from filesystem
async function loadScreenshot(): Promise<void> {
  try {
    const file = Bun.file(SCREENSHOT_PATH);
    if (await file.exists()) {
      const stat = await file.stat();
      // Only reload if file was modified
      if (stat.mtime.getTime() !== screenshotLastModified) {
        currentScreenshot = Buffer.from(await file.arrayBuffer());
        screenshotLastModified = stat.mtime.getTime();
        screenshotEtag = `${stat.mtime.getTime()}-${stat.size}`;
      }
    }
  } catch {
    // File might not exist yet during startup
  }
}

// Screenshot update loop - reload from disk every second
setInterval(loadScreenshot, 1000);

// Initial screenshot load
loadScreenshot();
