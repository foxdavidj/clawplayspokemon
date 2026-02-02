/**
 * UDP client for communication with the RetroArch emulator.
 *
 * Provides functions to:
 * - Read memory via UDP port 55355
 * - Send button inputs via UDP port 55400
 */

import { createSocket, type Socket } from "dgram";
import { lookup } from "dns/promises";
import type { Button } from "../types";

// Configuration from environment
const EMULATOR_HOST = process.env.EMULATOR_HOST || "emulator";
const EMULATOR_MEMORY_PORT = parseInt(process.env.EMULATOR_MEMORY_PORT || "55355", 10);
const EMULATOR_INPUT_PORT = parseInt(process.env.EMULATOR_INPUT_PORT || "55400", 10);
const UDP_TIMEOUT_MS = parseInt(process.env.UDP_TIMEOUT_MS || "2000", 10);
const UDP_RETRIES = parseInt(process.env.UDP_RETRIES || "3", 10);

// Resolved emulator IP address (populated at startup)
// Bun has issues with DNS resolution in Docker, so we resolve once and cache
let emulatorIP: string | null = null;

/**
 * Resolve the emulator hostname to an IP address.
 * This works around Bun's DNS resolution issues in Docker containers.
 */
async function resolveEmulatorHost(): Promise<string> {
  // If it's already an IP address, use it directly
  if (/^\d+\.\d+\.\d+\.\d+$/.test(EMULATOR_HOST)) {
    console.log(`Emulator host is already an IP: ${EMULATOR_HOST}`);
    return EMULATOR_HOST;
  }

  try {
    const result = await lookup(EMULATOR_HOST, { family: 4 });
    console.log(`Resolved emulator hostname '${EMULATOR_HOST}' to ${result.address}`);
    return result.address;
  } catch (err) {
    console.error(`Failed to resolve emulator hostname '${EMULATOR_HOST}':`, err);
    // Fall back to hostname and hope for the best
    return EMULATOR_HOST;
  }
}

/**
 * Get the emulator IP, resolving if needed.
 */
async function getEmulatorIP(): Promise<string> {
  if (!emulatorIP) {
    emulatorIP = await resolveEmulatorHost();
  }
  return emulatorIP;
}

// Resolve hostname at module load time
resolveEmulatorHost().then((ip) => {
  emulatorIP = ip;
});

// Button bitmask values for RetroArch network gamepad
const BUTTON_BITMASKS: Record<Button, number> = {
  a: 1,
  b: 2,
  select: 4,
  start: 8,
  right: 16,
  left: 32,
  up: 64,
  down: 128,
  r: 256,
  l: 512,
};

/**
 * Send a UDP message and wait for a response with timeout.
 */
async function sendUdpWithResponse(
  port: number,
  message: string,
  timeoutMs: number
): Promise<string | null> {
  const host = await getEmulatorIP();

  return new Promise((resolve) => {
    const socket: Socket = createSocket("udp4");
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        socket.close();
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    socket.on("message", (data) => {
      clearTimeout(timeout);
      cleanup();
      resolve(data.toString());
    });

    socket.on("error", (err) => {
      console.error("UDP socket error:", err);
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    });

    socket.send(message, port, host, (err) => {
      if (err) {
        console.error("UDP send error:", err);
        clearTimeout(timeout);
        cleanup();
        resolve(null);
      }
    });
  });
}

/**
 * Send a UDP message without waiting for response (fire-and-forget).
 */
async function sendUdpNoResponse(
  port: number,
  message: string
): Promise<void> {
  const host = await getEmulatorIP();

  return new Promise((resolve, reject) => {
    const socket: Socket = createSocket("udp4");

    socket.send(message, port, host, (err) => {
      socket.close();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Parse the response from READ_CORE_MEMORY command.
 * Format: "READ_CORE_MEMORY ADDR XX XX XX ..."
 * Returns null if response is invalid or an error.
 */
function parseMemoryResponse(response: string): Uint8Array | null {
  const parts = response.trim().split(/\s+/);

  // Check for error response
  if (parts[0] === "-1") {
    return null;
  }

  // Valid response: "READ_CORE_MEMORY ADDR XX XX XX ..."
  if (parts[0] !== "READ_CORE_MEMORY" || parts.length < 3) {
    return null;
  }

  // Skip command name and address, parse hex bytes
  const hexBytes = parts.slice(2);
  try {
    const bytes = hexBytes.map((hex) => parseInt(hex, 16));
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/**
 * Read memory from the emulator with retry logic.
 *
 * @param address - Memory address to read from (e.g., 0x02024284)
 * @param length - Number of bytes to read
 * @returns Uint8Array of bytes, or null if read failed
 */
export async function readMemory(
  address: number,
  length: number
): Promise<Uint8Array | null> {
  const command = `READ_CORE_MEMORY ${address.toString(16).toUpperCase().padStart(8, "0")} ${length}`;

  for (let attempt = 0; attempt < UDP_RETRIES; attempt++) {
    const response = await sendUdpWithResponse(
      EMULATOR_MEMORY_PORT,
      command,
      UDP_TIMEOUT_MS
    );

    if (response) {
      const bytes = parseMemoryResponse(response);
      if (bytes) {
        return bytes;
      }
    }

    // Wait a bit before retry
    if (attempt < UDP_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return null;
}

/**
 * Press a button on the emulator and release it.
 *
 * @param button - Button to press
 * @param durationMs - How long to hold the button (default 100ms)
 */
export async function pressButton(
  button: Button,
  durationMs: number = 100
): Promise<void> {
  const bitmask = BUTTON_BITMASKS[button];
  if (bitmask === undefined) {
    console.error(`Invalid button: ${button}`);
    return;
  }

  try {
    console.log(`Sending button press to RetroArch: ${button}`);

    // Press button
    await sendUdpNoResponse(EMULATOR_INPUT_PORT, String(bitmask));

    // Hold for duration
    await new Promise((r) => setTimeout(r, durationMs));

    // Release button
    await sendUdpNoResponse(EMULATOR_INPUT_PORT, "0");

    console.log(`Button pressed: ${button}`);
  } catch (err) {
    console.error(`Failed to press button ${button}:`, err);
  }
}

/**
 * Read a 16-bit little-endian unsigned integer from a byte array.
 */
export function readU16LE(data: Uint8Array, offset: number = 0): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

/**
 * Read a 32-bit little-endian unsigned integer from a byte array.
 */
export function readU32LE(data: Uint8Array, offset: number = 0): number {
  return (
    (data[offset] ?? 0) |
    ((data[offset + 1] ?? 0) << 8) |
    ((data[offset + 2] ?? 0) << 16) |
    (((data[offset + 3] ?? 0) << 24) >>> 0)
  );
}
