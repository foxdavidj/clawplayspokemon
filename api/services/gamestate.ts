/**
 * Pokemon FireRed (US v1.0) game state reader.
 *
 * Reads game state from emulator memory via UDP.
 * Handles DMA-protected save blocks and Pokemon data structures.
 *
 * IMPORTANT NOTES ON MEMORY LAYOUT:
 * - Save Block pointers at 0x03005008 (SB1) and 0x0300500C (SB2) are in IWRAM
 * - The actual blocks live in EWRAM and get relocated by DMA protection
 * - ALL data (party, money, badges, etc.) must be read relative to these pointers
 * - Never use hardcoded EWRAM addresses for save block data
 *
 * Reference: pret/pokefirered decomp (include/global.h)
 */

import { readMemory, readU16LE, readU32LE } from "./emulator";
import type { GameState, PokemonPartyMember } from "../types";

// ─── Memory addresses for Pokemon FireRed US v1.0 ───────────────────────────

// IWRAM pointers to DMA-protected save blocks (these are FIXED addresses)
const SAVE_BLOCK_1_PTR = 0x03005008; // Pointer to Save Block 1
const SAVE_BLOCK_2_PTR = 0x0300500c; // Pointer to Save Block 2

// ─── Save Block 1 offsets (from pret/pokefirered decomp) ────────────────────
//
// struct SaveBlock1 {
//   /*0x0000*/ struct Coords16 pos;           // 4 bytes (x: u16, y: u16)
//   /*0x0004*/ struct WarpData location;      // 8 bytes (mapGroup: s8, mapNum: s8, warpId: s8, pad, x: s16, y: s16)
//   ...
//   /*0x0034*/ u8 playerPartyCount;           // 1 byte + 3 padding
//   /*0x0038*/ struct Pokemon playerParty[6]; // 6 × 100 bytes = 600 bytes
//   /*0x0290*/ u32 money;                     // XOR encrypted with SB2 key
//   ...
//   /*0x0EE0*/ u8 flags[288];                 // Game flags (badges at flag 0x820+)
// }

const POSITION_OFFSET     = 0x0000; // Coords16 pos + WarpData location
const PARTY_COUNT_OFFSET  = 0x0034; // u8 playerPartyCount
const PARTY_DATA_OFFSET   = 0x0038; // struct Pokemon playerParty[6] — INSIDE SB1, not a fixed address!
const PARTY_SLOT_SIZE     = 100;    // sizeof(struct Pokemon) for party members
const MONEY_OFFSET        = 0x0290; // u32 money (XOR encrypted) — was WRONG at 0x0218
const BADGE_FLAGS_OFFSET  = 0x0fe4; // Byte containing badge flags (flags 0x820–0x827)

// ─── Save Block 2 offsets ───────────────────────────────────────────────────
//
// struct SaveBlock2 {
//   /*0x0000*/ u8 playerName[8];
//   /*0x0008*/ u8 playerGender;
//   ...
//   /*0x000E*/ struct Time playTime;  // hours: u16, minutes: u8, seconds: u8, frames: u8
//   ...
//   /*0x0F20*/ u32 encryptionKey;
// }

const PLAYER_NAME_OFFSET      = 0x0000;
const PLAY_TIME_HOURS_OFFSET  = 0x000e;
const PLAY_TIME_MINUTES_OFFSET = 0x0010;
const PLAY_TIME_SECONDS_OFFSET = 0x0011;
const MONEY_XOR_KEY_OFFSET    = 0x0f20;

// ─── Party Pokemon structure offsets (100-byte party struct) ────────────────
const POKEMON_PERSONALITY_OFFSET  = 0x00; // u32 personality value
const POKEMON_NICKNAME_OFFSET     = 0x08;
const POKEMON_NICKNAME_LENGTH     = 10;
const POKEMON_LEVEL_OFFSET        = 0x54; // u8 level (in calculated stats section)
const POKEMON_CURRENT_HP_OFFSET   = 0x56; // u16 currentHP
const POKEMON_MAX_HP_OFFSET       = 0x58; // u16 maxHP
const POKEMON_STATUS_OFFSET       = 0x50; // u32 status condition

// ─── Gen III character encoding table ───────────────────────────────────────
const GEN3_CHARSET: Record<number, string> = {
  0x00: " ",
  0xab: "!", 0xac: "?", 0xad: ".", 0xb0: "-",
  0xb1: "…", 0xb2: "\u201c", 0xb3: "\u201d", 0xb4: "\u2018", 0xb5: "\u2019",
  // Uppercase A-Z (0xBB-0xD4)
  0xbb: "A", 0xbc: "B", 0xbd: "C", 0xbe: "D", 0xbf: "E",
  0xc0: "F", 0xc1: "G", 0xc2: "H", 0xc3: "I", 0xc4: "J",
  0xc5: "K", 0xc6: "L", 0xc7: "M", 0xc8: "N", 0xc9: "O",
  0xca: "P", 0xcb: "Q", 0xcc: "R", 0xcd: "S", 0xce: "T",
  0xcf: "U", 0xd0: "V", 0xd1: "W", 0xd2: "X", 0xd3: "Y",
  0xd4: "Z",
  // Lowercase a-z (0xD5-0xEE)
  0xd5: "a", 0xd6: "b", 0xd7: "c", 0xd8: "d", 0xd9: "e",
  0xda: "f", 0xdb: "g", 0xdc: "h", 0xdd: "i", 0xde: "j",
  0xdf: "k", 0xe0: "l", 0xe1: "m", 0xe2: "n", 0xe3: "o",
  0xe4: "p", 0xe5: "q", 0xe6: "r", 0xe7: "s", 0xe8: "t",
  0xe9: "u", 0xea: "v", 0xeb: "w", 0xec: "x", 0xed: "y",
  0xee: "z",
  // Numbers 0-9 (0xA1-0xAA)
  0xa1: "0", 0xa2: "1", 0xa3: "2", 0xa4: "3", 0xa5: "4",
  0xa6: "5", 0xa7: "6", 0xa8: "7", 0xa9: "8", 0xaa: "9",
  0xff: "", // Terminator
};

// ─── Badge names in bit order (flags 0x820–0x827) ──────────────────────────
const BADGE_NAMES = [
  "Boulder",  // Brock - Pewter City
  "Cascade",  // Misty - Cerulean City
  "Thunder",  // Lt. Surge - Vermilion City
  "Rainbow",  // Erika - Celadon City
  "Soul",     // Koga - Fuchsia City
  "Marsh",    // Sabrina - Saffron City
  "Volcano",  // Blaine - Cinnabar Island
  "Earth",    // Giovanni - Viridian City
];

// ─── Complete FireRed Map Names ─────────────────────────────────────────────
// Key format: "mapGroup:mapNum"
// Sources: pret/pokefirered decomp, JPAN's research, Advance Map data
//
// Bank 0:  Link/connection corners
// Bank 1:  Caves, forests, major dungeons (123 maps)
// Bank 2:  Sevii dungeons - Trainer Tower, Lost Cave, Navel Rock, etc (60 maps)
// Bank 3:  Towns and routes (66 maps)
// Bank 4+: Indoor maps grouped by parent town/city

const MAP_NAMES: Record<string, string> = {
  // ── Bank 3: Towns, Cities, and Routes ──────────────────────────────────
  // Towns & Cities (indices 0–10)
  "3:0":  "Pallet Town",
  "3:1":  "Viridian City",
  "3:2":  "Pewter City",
  "3:3":  "Cerulean City",
  "3:4":  "Lavender Town",
  "3:5":  "Vermilion City",
  "3:6":  "Celadon City",
  "3:7":  "Fuchsia City",
  "3:8":  "Cinnabar Island",
  "3:9":  "Indigo Plateau",
  "3:10": "Saffron City",

  // Sevii Islands towns (indices 11–17)
  "3:11": "One Island",
  "3:12": "Two Island",
  "3:13": "Three Island",
  "3:14": "Four Island",
  "3:15": "Five Island",
  "3:16": "Six Island",
  "3:17": "Seven Island",

  // Kanto Routes (indices 18–42)
  "3:18": "Route 1",
  "3:19": "Route 2",
  "3:20": "Route 3",
  "3:21": "Route 4",
  "3:22": "Route 5",
  "3:23": "Route 6",
  "3:24": "Route 7",
  "3:25": "Route 8",
  "3:26": "Route 9",
  "3:27": "Route 10",
  "3:28": "Route 11",
  "3:29": "Route 12",
  "3:30": "Route 13",
  "3:31": "Route 14",
  "3:32": "Route 15",
  "3:33": "Route 16",
  "3:34": "Route 17",
  "3:35": "Route 18",
  "3:36": "Route 19",
  "3:37": "Route 20",
  "3:38": "Route 21 North",
  "3:39": "Route 22",
  "3:40": "Route 23",
  "3:41": "Route 24",
  "3:42": "Route 25",

  // Sevii Islands routes & water routes (indices 43–65)
  "3:43": "Kindle Road",
  "3:44": "Treasure Beach",
  "3:45": "Cape Brink",
  "3:46": "Bond Bridge",
  "3:47": "Three Isle Port",
  "3:48": "Resort Gorgeous",
  "3:49": "Water Labyrinth",
  "3:50": "Five Isle Meadow",
  "3:51": "Memorial Pillar",
  "3:52": "Outcast Island",
  "3:53": "Green Path",
  "3:54": "Water Path",
  "3:55": "Ruin Valley",
  "3:56": "Trainer Tower Exterior",
  "3:57": "Sevault Canyon",
  "3:58": "Tanoby Ruins",
  "3:59": "Three Isle Path",
  "3:60": "Route 21 South",
  "3:61": "Navel Rock Exterior",
  "3:62": "Birth Island Exterior",
  "3:63": "Pattern Bush Exterior",
  "3:64": "Altering Cave Exterior",
  "3:65": "Six Island Water",

  // ── Bank 4: Pallet Town Buildings ──────────────────────────────────────
  "4:0": "Pallet Town - Player's House 1F",
  "4:1": "Pallet Town - Player's House 2F",
  "4:2": "Pallet Town - Rival's House",
  "4:3": "Pallet Town - Oak's Lab",

  // ── Bank 5: Viridian City Buildings ────────────────────────────────────
  "5:0": "Viridian City - House",
  "5:1": "Viridian City - Gym",
  "5:2": "Viridian City - School",
  "5:3": "Viridian City - House 2",
  "5:4": "Viridian City - Poke Mart",
  "5:5": "Viridian City - Pokemon Center",

  // ── Bank 6: Pewter City Buildings ──────────────────────────────────────
  "6:0": "Pewter City - Museum 1F",
  "6:1": "Pewter City - Museum 2F",
  "6:2": "Pewter City - Gym",
  "6:3": "Pewter City - House",
  "6:4": "Pewter City - House 2",
  "6:5": "Pewter City - Pokemon Center",
  "6:6": "Pewter City - Poke Mart",
  "6:7": "Pewter City - House 3",

  // ── Bank 7: Cerulean City Buildings ────────────────────────────────────
  "7:0": "Cerulean City - House (Robbed)",
  "7:1": "Cerulean City - Bike Shop",
  "7:2": "Cerulean City - House 2",
  "7:3": "Cerulean City - Pokemon Center",
  "7:4": "Cerulean City - Poke Mart",
  "7:5": "Cerulean City - Gym",
  "7:6": "Cerulean City - Badge House",
  "7:7": "Cerulean City - House 3",
  "7:8": "Cerulean City - House 4",
  "7:9": "Cerulean City - House 5",

  // ── Bank 8: Lavender Town Buildings ────────────────────────────────────
  "8:0": "Lavender Town - Pokemon Center",
  "8:1": "Lavender Town - Volunteer House",
  "8:2": "Lavender Town - House",
  "8:3": "Lavender Town - Poke Mart",
  "8:4": "Lavender Town - House 2",
  "8:5": "Lavender Town - Name Rater",

  // ── Bank 9: Vermilion City Buildings ───────────────────────────────────
  "9:0": "Vermilion City - House (Fishing Guru)",
  "9:1": "Vermilion City - Pokemon Center",
  "9:2": "Vermilion City - Poke Mart",
  "9:3": "Vermilion City - Gym",
  "9:4": "Vermilion City - Fan Club",
  "9:5": "Vermilion City - House 2",
  "9:6": "Vermilion City - Dock",
  "9:7": "Vermilion City - House 3",

  // ── Bank 10: Celadon City Buildings ────────────────────────────────────
  "10:0":  "Celadon City - Dept Store 1F",
  "10:1":  "Celadon City - Dept Store 2F",
  "10:2":  "Celadon City - Dept Store 3F",
  "10:3":  "Celadon City - Dept Store 4F",
  "10:4":  "Celadon City - Dept Store 5F",
  "10:5":  "Celadon City - Dept Store Roof",
  "10:6":  "Celadon City - Dept Store Elevator",
  "10:7":  "Celadon City - Mansion 1F",
  "10:8":  "Celadon City - Mansion 2F",
  "10:9":  "Celadon City - Mansion 3F",
  "10:10": "Celadon City - Mansion Roof",
  "10:11": "Celadon City - Game Corner Prize Room",
  "10:12": "Celadon City - Pokemon Center",
  "10:13": "Celadon City - Poke Mart",
  "10:14": "Celadon City - Game Corner",
  "10:15": "Celadon City - Diner",
  "10:16": "Celadon City - Gym",
  "10:17": "Celadon City - Hotel",
  "10:18": "Celadon City - House",
  "10:19": "Celadon City - House 2",

  // ── Bank 11: Fuchsia City Buildings ────────────────────────────────────
  "11:0": "Fuchsia City - Safari Zone Gate",
  "11:1": "Fuchsia City - House",
  "11:2": "Fuchsia City - Gym",
  "11:3": "Fuchsia City - Safari Zone Office",
  "11:4": "Fuchsia City - Good Rod House",
  "11:5": "Fuchsia City - Pokemon Center",
  "11:6": "Fuchsia City - Poke Mart",
  "11:7": "Fuchsia City - Warden's House",
  "11:8": "Fuchsia City - House 2",
  "11:9": "Fuchsia City - House 3",

  // ── Bank 12: Cinnabar Island Buildings ─────────────────────────────────
  "12:0": "Cinnabar Island - Pokemon Lab",
  "12:1": "Cinnabar Island - Lab Experiment Room",
  "12:2": "Cinnabar Island - Lab Lounge",
  "12:3": "Cinnabar Island - Lab Research Room",
  "12:4": "Cinnabar Island - Gym",
  "12:5": "Cinnabar Island - Pokemon Center",
  "12:6": "Cinnabar Island - Poke Mart",
  "12:7": "Cinnabar Island - House",

  // ── Bank 13: Indigo Plateau ────────────────────────────────────────────
  "13:0": "Indigo Plateau - Pokemon Center",
  "13:1": "Indigo Plateau - Lobby",

  // ── Bank 14: Saffron City Buildings ────────────────────────────────────
  "14:0": "Saffron City - Copycat's House 1F",
  "14:1": "Saffron City - Copycat's House 2F",
  "14:2": "Saffron City - Gym",
  "14:3": "Saffron City - Fighting Dojo",
  "14:4": "Saffron City - House",
  "14:5": "Saffron City - House 2",
  "14:6": "Saffron City - Pokemon Center",
  "14:7": "Saffron City - Poke Mart",
  "14:8": "Saffron City - House 3",
  "14:9": "Saffron City - Psychic House",

  // ── Bank 1: Major Dungeons (selected entries) ──────────────────────────
  "1:0":  "Viridian Forest",
  "1:1":  "Mt. Moon 1F",
  "1:2":  "Mt. Moon B1F",
  "1:3":  "Mt. Moon B2F",
  "1:4":  "S.S. Anne Exterior",
  "1:5":  "S.S. Anne 1F Corridor",
  "1:31": "Underground Path (5-6)",
  "1:32": "Underground Path (7-8)",
  "1:34": "Digletts Cave North",
  "1:37": "Viridian Forest (Full)",
  "1:39": "Rock Tunnel 1F",
  "1:40": "Rock Tunnel B1F",
  "1:42": "Seafoam Islands 1F",
  "1:47": "Pokemon Tower 1F",
  "1:48": "Pokemon Tower 2F",
  "1:49": "Pokemon Tower 3F",
  "1:50": "Pokemon Tower 4F",
  "1:51": "Pokemon Tower 5F",
  "1:52": "Pokemon Tower 6F",
  "1:53": "Pokemon Tower 7F",
  "1:59": "Pokemon Mansion 1F",
  "1:60": "Pokemon Mansion 2F",
  "1:61": "Pokemon Mansion 3F",
  "1:62": "Pokemon Mansion B1F",
  "1:63": "Safari Zone Center",
  "1:64": "Safari Zone East",
  "1:65": "Safari Zone North",
  "1:66": "Safari Zone West",
  "1:72": "Silph Co. 1F",
  "1:81": "Victory Road 1F",
  "1:82": "Victory Road 2F",
  "1:83": "Rocket Hideout B1F",
  "1:84": "Rocket Hideout B2F",
  "1:85": "Rocket Hideout B3F",
  "1:86": "Rocket Hideout B4F",
  "1:88": "Silph Co. 2F",
  "1:95": "Cerulean Cave 1F",
  "1:96": "Cerulean Cave 2F",
  "1:97": "Cerulean Cave B1F",
  "1:109": "Power Plant",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decode Gen III encoded string to ASCII.
 */
function decodeGen3String(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    if (byte === 0xff) break;
    result += GEN3_CHARSET[byte] ?? "?";
  }
  return result;
}

/**
 * Get status condition string from status value.
 */
function getStatusString(status: number): string {
  if (status === 0) return "OK";
  if ((status & 0x07) !== 0) return "Sleep";
  if (status & 0x08) return "Poison";
  if (status & 0x10) return "Burn";
  if (status & 0x20) return "Freeze";
  if (status & 0x40) return "Paralysis";
  if (status & 0x80) return "Bad Poison";
  return "OK";
}

// ─── Save Block Pointer Reading ─────────────────────────────────────────────

/**
 * Read the DMA-protected save block pointers from IWRAM.
 * These pointers are FIXED addresses but point to MOVING targets in EWRAM.
 */
async function readSaveBlockPointers(): Promise<{ sb1: number; sb2: number } | null> {
  const sb1Data = await readMemory(SAVE_BLOCK_1_PTR, 4);
  const sb2Data = await readMemory(SAVE_BLOCK_2_PTR, 4);

  if (!sb1Data || !sb2Data) {
    return null;
  }

  const sb1 = readU32LE(sb1Data);
  const sb2 = readU32LE(sb2Data);

  // Sanity check: SB1 and SB2 should be in EWRAM (0x02000000–0x0203FFFF)
  if (sb1 < 0x02000000 || sb1 > 0x0203ffff) {
    console.error(`SB1 pointer out of EWRAM range: 0x${sb1.toString(16)}`);
    return null;
  }
  if (sb2 < 0x02000000 || sb2 > 0x0203ffff) {
    console.error(`SB2 pointer out of EWRAM range: 0x${sb2.toString(16)}`);
    return null;
  }

  return { sb1, sb2 };
}

// ─── Save Block 1 Readers ───────────────────────────────────────────────────

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
 * Read money from Save Block 1 (XOR decrypted with SB2 key).
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
 * Read player position and current map from Save Block 1.
 *
 * Memory layout at SB1+0x0000:
 *   [0-1] pos.x (s16)    — camera/player X coordinate
 *   [2-3] pos.y (s16)    — camera/player Y coordinate
 *   [4]   mapGroup (s8)  — map group (bank) number
 *   [5]   mapNum (s8)    — map number within group
 */
async function readPosition(sb1Base: number): Promise<{ map_id: number; name: string } | null> {
  const posData = await readMemory(sb1Base + POSITION_OFFSET, 8);
  if (!posData || posData.length < 6) return null;

  // Bytes 4 and 5 are mapGroup and mapNum from WarpData.location
  const mapGroup = posData[4] ?? 0;
  const mapNum   = posData[5] ?? 0;
  const mapKey   = `${mapGroup}:${mapNum}`;

  return {
    map_id: (mapGroup << 8) | mapNum,
    name: MAP_NAMES[mapKey] ?? `Unknown (${mapGroup}:${mapNum})`,
  };
}

// ─── Party Pokemon Reading ──────────────────────────────────────────────────

/**
 * Read party count from Save Block 1.
 * The count is a u8 at offset 0x0034 within the DMA-protected block.
 */
async function readPartyCount(sb1Base: number): Promise<number> {
  const countData = await readMemory(sb1Base + PARTY_COUNT_OFFSET, 4);
  if (!countData || countData.length === 0) {
    console.error("Failed to read party count from memory");
    return 0;
  }

  const count = countData[0] ?? 0;

  // Debug: log the raw bytes so we can diagnose issues
  const hexBytes = Array.from(countData).map(b => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`Party count raw bytes at 0x${(sb1Base + PARTY_COUNT_OFFSET).toString(16)}: [${hexBytes}] → count=${count}`);

  if (count > 6) {
    console.warn(`Party count ${count} exceeds maximum of 6, clamping`);
    return 6;
  }

  return count;
}

/**
 * Read a single party Pokemon from Save Block 1.
 *
 * CRITICAL: Party data lives INSIDE SaveBlock1 at offset 0x0038.
 * It MUST be read relative to the SB1 pointer, NOT from a fixed EWRAM address.
 * The old hardcoded address 0x02024284 is a battle-time copy and will be stale/empty
 * outside of battles, or will point to wrong data after DMA shifts.
 */
async function readPartyPokemon(sb1Base: number, slot: number): Promise<PokemonPartyMember | null> {
  const address = sb1Base + PARTY_DATA_OFFSET + (slot * PARTY_SLOT_SIZE);
  const data = await readMemory(address, PARTY_SLOT_SIZE);

  if (!data) {
    console.error(`Failed to read party slot ${slot} from 0x${address.toString(16)}`);
    return null;
  }

  // Debug: log first 8 bytes of each slot
  const headerHex = Array.from(data.slice(0, 8)).map(b => b.toString(16).padStart(2, "0")).join(" ");
  console.log(`Party slot ${slot} at 0x${address.toString(16)}: first 8 bytes = [${headerHex}]`);

  // Check if slot is empty (personality value = 0 means no Pokemon)
  const personality = readU32LE(data, POKEMON_PERSONALITY_OFFSET);
  if (personality === 0) {
    console.log(`Party slot ${slot}: personality=0, skipping (empty slot)`);
    return null;
  }

  // Read nickname
  const nicknameBytes = data.slice(POKEMON_NICKNAME_OFFSET, POKEMON_NICKNAME_OFFSET + POKEMON_NICKNAME_LENGTH);
  const nickname = decodeGen3String(nicknameBytes);

  // Read calculated stats (unencrypted in the party structure's appended section)
  const level = data[POKEMON_LEVEL_OFFSET] ?? 0;
  const currentHp = readU16LE(data, POKEMON_CURRENT_HP_OFFSET);
  const maxHp = readU16LE(data, POKEMON_MAX_HP_OFFSET);
  const statusValue = readU32LE(data, POKEMON_STATUS_OFFSET);

  console.log(`Party slot ${slot}: personality=0x${personality.toString(16)}, nickname="${nickname}", level=${level}, HP=${currentHp}/${maxHp}`);

  return {
    slot: slot + 1,
    species: "Pokemon", // Would need substructure decryption for species ID
    species_id: 0,
    nickname,
    level,
    hp: currentHp,
    max_hp: maxHp,
    status: getStatusString(statusValue),
    moves: [],
  };
}

/**
 * Read all party Pokemon from Save Block 1.
 */
async function readParty(sb1Base: number): Promise<PokemonPartyMember[]> {
  const partyCount = await readPartyCount(sb1Base);
  console.log(`Reading ${partyCount} party members from SB1 at 0x${sb1Base.toString(16)}`);

  if (partyCount === 0) {
    // Extra debug: try reading 16 bytes around the party count offset
    // to see if the data looks shifted
    const debugData = await readMemory(sb1Base + 0x0030, 16);
    if (debugData) {
      const hex = Array.from(debugData).map(b => b.toString(16).padStart(2, "0")).join(" ");
      console.log(`Debug: 16 bytes at SB1+0x0030: [${hex}]`);
      console.log(`  Offset 0x30-0x33 (pre-count padding): ${hex.substring(0, 11)}`);
      console.log(`  Offset 0x34 (party count byte):        ${hex.substring(12, 14)}`);
      console.log(`  Offset 0x35-0x37 (post-count padding): ${hex.substring(15, 23)}`);
      console.log(`  Offset 0x38-0x3F (first party bytes):  ${hex.substring(24)}`);
    }
    return [];
  }

  const party: PokemonPartyMember[] = [];

  for (let i = 0; i < partyCount; i++) {
    const pokemon = await readPartyPokemon(sb1Base, i);
    if (pokemon) {
      party.push(pokemon);
    }
  }

  return party;
}

// ─── Main Game State Reader ─────────────────────────────────────────────────

/**
 * Fetch complete game state from emulator memory.
 *
 * Save states work fine for this - they capture the entire RAM state
 * including DMA pointers. There is no dependency on in-game saves.
 */
export async function fetchGameState(): Promise<GameState | null> {
  // Step 1: Read DMA-protected save block pointers from IWRAM
  const pointers = await readSaveBlockPointers();
  if (!pointers) {
    console.log("Failed to read save block pointers");
    return null;
  }

  const { sb1, sb2 } = pointers;
  console.log(`Save block pointers: SB1=0x${sb1.toString(16)}, SB2=0x${sb2.toString(16)}`);

  // Step 2: Read all game state in parallel where possible
  const [player, badges, money, playTime, location, party] = await Promise.all([
    readPlayerName(sb2),
    readBadges(sb1),
    readMoney(sb1, sb2),
    readPlayTime(sb2),
    readPosition(sb1),
    readParty(sb1),
  ]);

  if (!player || !badges || money === null || !playTime || !location) {
    console.log("Failed to read some game state fields:", {
      player: !!player,
      badges: !!badges,
      money: money !== null,
      playTime: !!playTime,
      location: !!location,
    });
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
