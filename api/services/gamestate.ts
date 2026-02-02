/**
 * Pokemon FireRed (US v1.0) game state reader.
 *
 * Reads game state from emulator memory via UDP.
 * Handles DMA-protected save blocks and Pokemon data structures.
 */

import { readMemory, readU16LE, readU32LE } from "./emulator";
import type { GameState, PokemonPartyMember } from "../types";

// Memory addresses for Pokemon FireRed US v1.0
const SAVE_BLOCK_1_PTR = 0x03005008; // Pointer to Save Block 1 (in IWRAM)
const SAVE_BLOCK_2_PTR = 0x0300500c; // Pointer to Save Block 2 (in IWRAM)
const PARTY_BASE = 0x02024284; // Fixed EWRAM address for party Pokemon
const PARTY_SLOT_SIZE = 100; // Size of each party Pokemon structure

// Offsets within Save Block 1
const BADGE_FLAGS_OFFSET = 0x0fe4; // Offset to badge flags byte
const MONEY_OFFSET = 0x0218; // Offset to money (XOR encrypted)
const POSITION_OFFSET = 0x0000; // Offset to camera/player position
const PARTY_COUNT_OFFSET = 0x0034; // Offset to party count

// Offsets within Save Block 2
const PLAYER_NAME_OFFSET = 0x0000; // Offset to player name
const PLAY_TIME_HOURS_OFFSET = 0x000e; // Offset to play time hours
const PLAY_TIME_MINUTES_OFFSET = 0x0010; // Offset to play time minutes
const PLAY_TIME_SECONDS_OFFSET = 0x0011; // Offset to play time seconds
const MONEY_XOR_KEY_OFFSET = 0x0f20; // Offset to money XOR key

// Offsets within party Pokemon structure
const POKEMON_PERSONALITY_OFFSET = 0x00;
const POKEMON_NICKNAME_OFFSET = 0x08;
const POKEMON_NICKNAME_LENGTH = 10;
const POKEMON_LEVEL_OFFSET = 0x54;
const POKEMON_CURRENT_HP_OFFSET = 0x56;
const POKEMON_MAX_HP_OFFSET = 0x58;
const POKEMON_STATUS_OFFSET = 0x50;

// Gen III character encoding table (partial - common characters)
const GEN3_CHARSET: Record<number, string> = {
  0x00: " ",
  0xab: "!",
  0xac: "?",
  0xad: ".",
  0xb0: "-",
  0xb1: "...",
  0xb2: '"',
  0xb3: '"',
  0xb4: "'",
  0xb5: "'",
  // Uppercase letters A-Z (0xBB-0xD4)
  0xbb: "A", 0xbc: "B", 0xbd: "C", 0xbe: "D", 0xbf: "E",
  0xc0: "F", 0xc1: "G", 0xc2: "H", 0xc3: "I", 0xc4: "J",
  0xc5: "K", 0xc6: "L", 0xc7: "M", 0xc8: "N", 0xc9: "O",
  0xca: "P", 0xcb: "Q", 0xcc: "R", 0xcd: "S", 0xce: "T",
  0xcf: "U", 0xd0: "V", 0xd1: "W", 0xd2: "X", 0xd3: "Y",
  0xd4: "Z",
  // Lowercase letters a-z (0xD5-0xEE)
  0xd5: "a", 0xd6: "b", 0xd7: "c", 0xd8: "d", 0xd9: "e",
  0xda: "f", 0xdb: "g", 0xdc: "h", 0xdd: "i", 0xde: "j",
  0xdf: "k", 0xe0: "l", 0xe1: "m", 0xe2: "n", 0xe3: "o",
  0xe4: "p", 0xe5: "q", 0xe6: "r", 0xe7: "s", 0xe8: "t",
  0xe9: "u", 0xea: "v", 0xeb: "w", 0xec: "x", 0xed: "y",
  0xee: "z",
  // Numbers 0-9 (0xA1-0xAA)
  0xa1: "0", 0xa2: "1", 0xa3: "2", 0xa4: "3", 0xa5: "4",
  0xa6: "5", 0xa7: "6", 0xa8: "7", 0xa9: "8", 0xaa: "9",
  // Terminator
  0xff: "",
};

// Badge names in order (bit 0-7)
const BADGE_NAMES = [
  "Boulder",
  "Cascade",
  "Thunder",
  "Rainbow",
  "Soul",
  "Marsh",
  "Volcano",
  "Earth",
];

// Map bank/number to location name (simplified mapping)
const MAP_NAMES: Record<string, string> = {
  "3:0": "Pallet Town",
  "3:1": "Viridian City",
  "3:2": "Pewter City",
  "3:3": "Cerulean City",
  "3:4": "Lavender Town",
  "3:5": "Vermilion City",
  "3:6": "Celadon City",
  "3:7": "Fuchsia City",
  "3:8": "Cinnabar Island",
  "3:9": "Indigo Plateau",
  "3:10": "Saffron City",
  // Route defaults
  "3:11": "Route 1",
  "3:12": "Route 2",
  // Add more as needed
};

// Status condition flags
const STATUS_CONDITIONS: Record<number, string> = {
  0: "OK",
  1: "Sleep",
  2: "Sleep",
  3: "Sleep",
  4: "Poison",
  8: "Burn",
  16: "Freeze",
  32: "Paralysis",
  128: "Bad Poison",
};

/**
 * Decode Gen III encoded string to ASCII.
 */
function decodeGen3String(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    if (byte === 0xff) break; // Terminator
    result += GEN3_CHARSET[byte] ?? "?";
  }
  return result;
}

/**
 * Read the DMA-protected save block pointers.
 * These pointers change frequently due to DMA, so we must read them fresh each time.
 */
async function readSaveBlockPointers(): Promise<{ sb1: number; sb2: number } | null> {
  const sb1Data = await readMemory(SAVE_BLOCK_1_PTR, 4);
  const sb2Data = await readMemory(SAVE_BLOCK_2_PTR, 4);

  if (!sb1Data || !sb2Data) {
    return null;
  }

  return {
    sb1: readU32LE(sb1Data),
    sb2: readU32LE(sb2Data),
  };
}

/**
 * Read badge flags from Save Block 1.
 */
async function readBadges(sb1Base: number): Promise<Record<string, boolean> | null> {
  const badgeData = await readMemory(sb1Base + BADGE_FLAGS_OFFSET, 1);
  if (!badgeData || badgeData.length === 0) return null;

  const badgeByte = badgeData[0] ?? 0;
  const badges: Record<string, boolean> = {};

  for (let i = 0; i < BADGE_NAMES.length; i++) {
    const badgeName = BADGE_NAMES[i];
    if (badgeName) {
      badges[badgeName] = Boolean(badgeByte & (1 << i));
    }
  }

  return badges;
}

/**
 * Read money from Save Block 1 (XOR decrypted).
 */
async function readMoney(sb1Base: number, sb2Base: number): Promise<number | null> {
  const moneyData = await readMemory(sb1Base + MONEY_OFFSET, 4);
  const keyData = await readMemory(sb2Base + MONEY_XOR_KEY_OFFSET, 4);

  if (!moneyData || !keyData) return null;

  const rawMoney = readU32LE(moneyData);
  const xorKey = readU32LE(keyData);

  return rawMoney ^ xorKey;
}

/**
 * Read player name from Save Block 2.
 */
async function readPlayerName(sb2Base: number): Promise<string | null> {
  const nameData = await readMemory(sb2Base + PLAYER_NAME_OFFSET, 8);
  if (!nameData) return null;

  return decodeGen3String(nameData);
}

/**
 * Read play time from Save Block 2.
 */
async function readPlayTime(sb2Base: number): Promise<{ hours: number; minutes: number; seconds: number } | null> {
  const timeData = await readMemory(sb2Base + PLAY_TIME_HOURS_OFFSET, 4);
  if (!timeData || timeData.length < 4) return null;

  return {
    hours: readU16LE(timeData, 0),
    minutes: timeData[2] ?? 0,
    seconds: timeData[3] ?? 0,
  };
}

/**
 * Read player position from Save Block 1.
 */
async function readPosition(sb1Base: number): Promise<{ map_id: number; name: string } | null> {
  const posData = await readMemory(sb1Base + POSITION_OFFSET, 6);
  if (!posData || posData.length < 6) return null;

  const mapNum = posData[4] ?? 0;
  const mapBank = posData[5] ?? 0;
  const mapKey = `${mapBank}:${mapNum}`;

  return {
    map_id: (mapBank << 8) | mapNum,
    name: MAP_NAMES[mapKey] ?? `Map ${mapBank}:${mapNum}`,
  };
}

/**
 * Get status condition string from status value.
 */
function getStatusString(status: number): string {
  if (status === 0) return "OK";

  // Check sleep (values 1-7)
  if ((status & 0x07) !== 0) return "Sleep";

  // Check other conditions
  if (status & 0x08) return "Poison";
  if (status & 0x10) return "Burn";
  if (status & 0x20) return "Freeze";
  if (status & 0x40) return "Paralysis";
  if (status & 0x80) return "Bad Poison";

  return "OK";
}

/**
 * Read a single party Pokemon from fixed EWRAM address.
 */
async function readPartyPokemon(slot: number): Promise<PokemonPartyMember | null> {
  const address = PARTY_BASE + slot * PARTY_SLOT_SIZE;
  const data = await readMemory(address, PARTY_SLOT_SIZE);

  if (!data) return null;

  // Check if slot is empty (personality value = 0)
  const personality = readU32LE(data, POKEMON_PERSONALITY_OFFSET);
  if (personality === 0) return null;

  // Read nickname
  const nicknameBytes = data.slice(POKEMON_NICKNAME_OFFSET, POKEMON_NICKNAME_OFFSET + POKEMON_NICKNAME_LENGTH);
  const nickname = decodeGen3String(nicknameBytes);

  // Read stats (these are unencrypted in party structure)
  const level = data[POKEMON_LEVEL_OFFSET] ?? 0;
  const currentHp = readU16LE(data, POKEMON_CURRENT_HP_OFFSET);
  const maxHp = readU16LE(data, POKEMON_MAX_HP_OFFSET);
  const statusValue = readU32LE(data, POKEMON_STATUS_OFFSET);

  return {
    slot: slot + 1,
    species: "Pokemon", // Would need encrypted substructure decryption to get species
    species_id: 0, // Would need encrypted substructure decryption
    nickname,
    level,
    hp: currentHp,
    max_hp: maxHp,
    status: getStatusString(statusValue),
    moves: [], // Would need encrypted substructure decryption
  };
}

/**
 * Read party count from Save Block 1.
 */
async function readPartyCount(sb1Base: number): Promise<number> {
  const countData = await readMemory(sb1Base + PARTY_COUNT_OFFSET, 1);
  if (!countData || countData.length === 0) return 0;
  return Math.min(countData[0] ?? 0, 6); // Cap at 6
}

/**
 * Read all party Pokemon.
 */
async function readParty(sb1Base: number): Promise<PokemonPartyMember[]> {
  const partyCount = await readPartyCount(sb1Base);
  const party: PokemonPartyMember[] = [];

  for (let i = 0; i < partyCount; i++) {
    const pokemon = await readPartyPokemon(i);
    if (pokemon) {
      party.push(pokemon);
    }
  }

  return party;
}

/**
 * Fetch complete game state from emulator memory.
 */
export async function fetchGameState(): Promise<GameState | null> {
  // Read save block pointers first (they change due to DMA)
  const pointers = await readSaveBlockPointers();
  if (!pointers) {
    console.log("Failed to read save block pointers");
    return null;
  }

  const { sb1, sb2 } = pointers;

  // Read all game state in parallel where possible
  const [player, badges, money, playTime, location, party] = await Promise.all([
    readPlayerName(sb2),
    readBadges(sb1),
    readMoney(sb1, sb2),
    readPlayTime(sb2),
    readPosition(sb1),
    readParty(sb1),
  ]);

  if (!player || !badges || money === null || !playTime || !location) {
    console.log("Failed to read some game state fields");
    return null;
  }

  const badgeCount = Object.values(badges).filter(Boolean).length;

  return {
    player,
    badges: {
      count: badgeCount,
      badges,
    },
    party,
    location,
    money,
    play_time: playTime,
    timestamp: Date.now(),
  };
}
