"""
PyBoy emulator wrapper with save/load functionality.

Handles:
- Running the emulator in headless mode
- Button input execution
- Save state persistence (after votes + periodic auto-save)
- Screenshot capture
"""

import json
import os
import time
from pathlib import Path
from typing import Any, Optional
from PIL import Image
import numpy as np


# Pokemon Red/Blue Memory Addresses
ADDR_PARTY_COUNT = 0xD163
ADDR_PARTY_SPECIES = 0xD164  # 6 bytes
ADDR_PARTY_DATA = 0xD16B     # 44 bytes per Pokemon
ADDR_PARTY_NICKNAMES = 0xD2B5  # 11 bytes per nickname
ADDR_BADGES = 0xD356
ADDR_MONEY = 0xD347  # 3 bytes BCD
ADDR_PLAYER_NAME = 0xD158  # 11 bytes
ADDR_MAP_ID = 0xD35E
ADDR_PLAY_TIME_HOURS = 0xDA41    # 1 byte (0-255)
ADDR_PLAY_TIME_MINUTES = 0xDA43  # 1 byte (0-59)
ADDR_PLAY_TIME_SECONDS = 0xDA44  # 1 byte (0-59)

# Pokemon species names (Gen 1 index -> name)
POKEMON_NAMES = {
    0: "None", 1: "Rhydon", 2: "Kangaskhan", 3: "Nidoran♂", 4: "Clefairy",
    5: "Spearow", 6: "Voltorb", 7: "Nidoking", 8: "Slowbro", 9: "Ivysaur",
    10: "Exeggutor", 21: "Mew", 33: "Bulbasaur", 36: "Starmie", 46: "Diglett",
    64: "Wartortle", 65: "Mewtwo", 66: "Snorlax", 70: "Squirtle", 73: "Pikachu",
    84: "Venusaur", 85: "Tentacruel", 88: "Goldeen", 96: "Charizard",
    99: "Poliwrath", 100: "Blastoise", 102: "Haunter", 115: "Charmander",
    118: "Hitmonlee", 127: "Vaporeon", 128: "Jolteon", 133: "Flareon",
    147: "Alakazam", 150: "Gastly", 153: "Charmeleon", 165: "Lapras",
    177: "Gengar", 178: "Dragonite", 179: "Magikarp", 180: "Gyarados",
    # Add more as needed - this covers common ones
}

# Move names (Gen 1 index -> name)
MOVE_NAMES = {
    0: "—", 1: "Pound", 2: "Karate Chop", 3: "Double Slap", 4: "Comet Punch",
    5: "Mega Punch", 6: "Pay Day", 7: "Fire Punch", 8: "Ice Punch", 9: "Thunder Punch",
    10: "Scratch", 11: "Vice Grip", 12: "Guillotine", 13: "Razor Wind", 14: "Swords Dance",
    15: "Cut", 16: "Gust", 17: "Wing Attack", 18: "Whirlwind", 19: "Fly",
    20: "Bind", 21: "Slam", 22: "Vine Whip", 23: "Stomp", 24: "Double Kick",
    25: "Mega Kick", 26: "Jump Kick", 27: "Rolling Kick", 28: "Sand Attack", 29: "Headbutt",
    30: "Horn Attack", 31: "Fury Attack", 32: "Horn Drill", 33: "Tackle", 34: "Body Slam",
    35: "Wrap", 36: "Take Down", 37: "Thrash", 38: "Double-Edge", 39: "Tail Whip",
    40: "Poison Sting", 41: "Twineedle", 42: "Pin Missile", 43: "Leer", 44: "Bite",
    45: "Growl", 46: "Roar", 47: "Sing", 48: "Supersonic", 49: "Sonic Boom",
    50: "Disable", 51: "Acid", 52: "Ember", 53: "Flamethrower", 54: "Mist",
    55: "Water Gun", 56: "Hydro Pump", 57: "Surf", 58: "Ice Beam", 59: "Blizzard",
    60: "Psybeam", 61: "Bubble Beam", 62: "Aurora Beam", 63: "Hyper Beam", 64: "Peck",
    65: "Drill Peck", 66: "Submission", 67: "Low Kick", 68: "Counter", 69: "Seismic Toss",
    70: "Strength", 71: "Absorb", 72: "Mega Drain", 73: "Leech Seed", 74: "Growth",
    75: "Razor Leaf", 76: "Solar Beam", 77: "Poison Powder", 78: "Stun Spore", 79: "Sleep Powder",
    80: "Petal Dance", 81: "String Shot", 82: "Dragon Rage", 83: "Fire Spin", 84: "Thunder Shock",
    85: "Thunderbolt", 86: "Thunder Wave", 87: "Thunder", 88: "Rock Throw", 89: "Earthquake",
    90: "Fissure", 91: "Dig", 92: "Toxic", 93: "Confusion", 94: "Psychic",
    95: "Hypnosis", 96: "Meditate", 97: "Agility", 98: "Quick Attack", 99: "Rage",
    100: "Teleport", 101: "Night Shade", 102: "Mimic", 103: "Screech", 104: "Double Team",
    105: "Recover", 106: "Harden", 107: "Minimize", 108: "Smokescreen", 109: "Confuse Ray",
    110: "Withdraw", 111: "Defense Curl", 112: "Barrier", 113: "Light Screen", 114: "Haze",
    115: "Reflect", 116: "Focus Energy", 117: "Bide", 118: "Metronome", 119: "Mirror Move",
    120: "Self-Destruct", 121: "Egg Bomb", 122: "Lick", 123: "Smog", 124: "Sludge",
    125: "Bone Club", 126: "Fire Blast", 127: "Waterfall", 128: "Clamp", 129: "Swift",
    130: "Skull Bash", 131: "Spike Cannon", 132: "Constrict", 133: "Amnesia", 134: "Kinesis",
    135: "Soft-Boiled", 136: "High Jump Kick", 137: "Glare", 138: "Dream Eater", 139: "Poison Gas",
    140: "Barrage", 141: "Leech Life", 142: "Lovely Kiss", 143: "Sky Attack", 144: "Transform",
    145: "Bubble", 146: "Dizzy Punch", 147: "Spore", 148: "Flash", 149: "Psywave",
    150: "Splash", 151: "Acid Armor", 152: "Crabhammer", 153: "Explosion", 154: "Fury Swipes",
    155: "Bonemerang", 156: "Rest", 157: "Rock Slide", 158: "Hyper Fang", 159: "Sharpen",
    160: "Conversion", 161: "Tri Attack", 162: "Super Fang", 163: "Slash", 164: "Substitute",
    165: "Struggle",
}

# Map IDs to location names
MAP_NAMES = {
    0: "Pallet Town", 1: "Viridian City", 2: "Pewter City", 3: "Cerulean City",
    4: "Lavender Town", 5: "Vermilion City", 6: "Celadon City", 7: "Fuchsia City",
    8: "Cinnabar Island", 9: "Indigo Plateau", 10: "Saffron City", 11: "Unknown",
    12: "Route 1", 13: "Route 2", 14: "Route 3", 15: "Route 4", 16: "Route 5",
    17: "Route 6", 18: "Route 7", 19: "Route 8", 20: "Route 9", 21: "Route 10",
    22: "Route 11", 23: "Route 12", 24: "Route 13", 25: "Route 14", 26: "Route 15",
    27: "Route 16", 28: "Route 17", 29: "Route 18", 30: "Route 19", 31: "Route 20",
    32: "Route 21", 33: "Route 22", 34: "Route 23", 35: "Route 24", 36: "Route 25",
    37: "Player's House 1F", 38: "Player's House 2F", 39: "Rival's House",
    40: "Oak's Lab", 51: "Viridian Gym", 54: "Pewter Gym", 65: "Cerulean Gym",
    92: "Vermilion Gym", 134: "Celadon Gym", 157: "Fuchsia Gym", 166: "Cinnabar Gym",
    178: "Saffron Gym", 198: "Pokemon League",
    # Dungeons
    82: "Mt. Moon 1F", 83: "Mt. Moon B1F", 84: "Mt. Moon B2F",
    108: "Rock Tunnel 1F", 109: "Rock Tunnel B1F",
    142: "Pokemon Tower 1F", 143: "Pokemon Tower 2F", 144: "Pokemon Tower 3F",
    145: "Pokemon Tower 4F", 146: "Pokemon Tower 5F", 147: "Pokemon Tower 6F", 148: "Pokemon Tower 7F",
    181: "Silph Co. 1F", 207: "Victory Road 1F", 208: "Victory Road 2F", 209: "Victory Road 3F",
}

# Badge names in order
BADGE_NAMES = ["Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth"]

try:
    from pyboy import PyBoy
except ImportError:
    print("ERROR: PyBoy not installed. Run: pip install pyboy")
    raise


# Valid Game Boy buttons
VALID_BUTTONS = ["up", "down", "left", "right", "a", "b", "start", "select"]

# Button hold duration in frames (~133ms at 60 FPS)
BUTTON_HOLD_FRAMES = 8

# Audio settings
AUDIO_SAMPLE_RATE = 48000


class Emulator:
    """Wrapper around PyBoy with save state and screenshot support."""

    def __init__(
        self,
        rom_path: str,
        save_state_path: str,
        screenshot_path: str
    ):
        """
        Initialize the emulator.

        Args:
            rom_path: Path to the Game Boy ROM file
            save_state_path: Path for save state persistence
            screenshot_path: Path to write screenshots
        """
        self.rom_path = Path(rom_path).resolve()
        self.save_state_path = Path(save_state_path).resolve()
        self.screenshot_path = Path(screenshot_path).resolve()

        # Ensure parent directories exist
        self.save_state_path.parent.mkdir(parents=True, exist_ok=True)
        self.screenshot_path.parent.mkdir(parents=True, exist_ok=True)

        # Validate ROM exists
        if not self.rom_path.exists():
            raise FileNotFoundError(f"ROM not found: {self.rom_path}")

        # Initialize PyBoy in headless mode with audio
        print(f"Initializing PyBoy with ROM: {self.rom_path}")
        self.pyboy = PyBoy(
            str(self.rom_path),
            window="null",  # Headless mode
            sound_emulated=True,
            sound_sample_rate=AUDIO_SAMPLE_RATE,
            sound_volume=100
        )

        # Track button state for hold/release
        self._held_button: Optional[str] = None
        self._hold_frames_remaining: int = 0

        # Track last save time for auto-save
        self._last_save_time: float = time.time()

        # Load save state if it exists
        self._load_state_on_startup()

    def _load_state_on_startup(self) -> None:
        """Load save state if it exists from a previous session."""
        if self.save_state_path.exists():
            try:
                print(f"Loading save state from: {self.save_state_path}")
                with open(self.save_state_path, "rb") as f:
                    self.pyboy.load_state(f)
                print("Save state loaded successfully")
            except Exception as e:
                print(f"WARNING: Failed to load save state: {e}")
                print("Starting fresh game...")
        else:
            print("No existing save state found, starting fresh")

    def save_state(self) -> bool:
        """
        Save the current emulator state to disk.

        Returns:
            True if save was successful, False otherwise
        """
        try:
            # Create a temporary file first, then rename for atomicity
            temp_path = self.save_state_path.with_suffix(".tmp")
            with open(temp_path, "wb") as f:
                self.pyboy.save_state(f)

            # Atomic rename
            temp_path.replace(self.save_state_path)

            self._last_save_time = time.time()
            return True
        except Exception as e:
            print(f"ERROR: Failed to save state: {e}")
            return False

    def save_screenshot(self) -> bool:
        """
        Save the current screen to the screenshot path.

        Returns:
            True if save was successful, False otherwise
        """
        try:
            # Get the screen image from PyBoy
            screen_image = self.pyboy.screen.image

            # Save to a temp file first, then rename for atomicity
            temp_path = self.screenshot_path.with_suffix(".tmp.png")
            screen_image.save(temp_path, "PNG")

            # Atomic rename
            temp_path.replace(self.screenshot_path)

            return True
        except Exception as e:
            print(f"ERROR: Failed to save screenshot: {e}")
            return False

    def get_screen_image(self) -> Image.Image:
        """
        Get the current screen as a PIL Image.

        Returns:
            Copy of the current screen image
        """
        return self.pyboy.screen.image.copy()

    def press_button(self, button: str) -> bool:
        """
        Press and hold a button. Will be released after BUTTON_HOLD_FRAMES.

        Args:
            button: One of: up, down, left, right, a, b, start, select

        Returns:
            True if button was valid and pressed, False otherwise
        """
        button = button.lower()

        if button not in VALID_BUTTONS:
            print(f"WARNING: Invalid button: {button}")
            return False

        # Release any currently held button
        if self._held_button is not None:
            self._release_current_button()

        # Press the new button
        self.pyboy.button(button)
        self._held_button = button
        self._hold_frames_remaining = BUTTON_HOLD_FRAMES

        return True

    def _release_current_button(self) -> None:
        """Release the currently held button."""
        if self._held_button is not None:
            self.pyboy.button_release(self._held_button)
            self._held_button = None
            self._hold_frames_remaining = 0

    def tick(self) -> np.ndarray:
        """
        Advance the emulator by one frame.

        Also handles button release timing.

        Returns:
            Audio samples generated this frame (numpy array, int16 stereo)
        """
        # Tick the emulator with sound
        self.pyboy.tick(sound=True)

        # Get audio samples
        audio_data = self.pyboy.sound.ndarray.copy()

        # Handle button hold/release
        if self._hold_frames_remaining > 0:
            self._hold_frames_remaining -= 1
            if self._hold_frames_remaining == 0:
                self._release_current_button()

        return audio_data

    def tick_multiple(self, count: int) -> None:
        """
        Advance the emulator by multiple frames.

        Args:
            count: Number of frames to advance
        """
        for _ in range(count):
            self.tick()

    def should_auto_save(self, interval_seconds: float = 60.0) -> bool:
        """
        Check if enough time has passed for an auto-save.

        Args:
            interval_seconds: Minimum time between auto-saves

        Returns:
            True if auto-save should be triggered
        """
        return (time.time() - self._last_save_time) >= interval_seconds

    def stop(self) -> None:
        """Stop the emulator and save final state."""
        print("Stopping emulator...")

        # Final save before shutdown
        print("Saving final state...")
        self.save_state()

        # Release any held button
        self._release_current_button()

        # Stop PyBoy
        self.pyboy.stop()
        print("Emulator stopped")

    @property
    def screen_size(self) -> tuple[int, int]:
        """Get the screen dimensions (width, height)."""
        # Game Boy screen is 160x144, but PyBoy renders at 160x144 or scaled
        # PyBoy's screen.image gives us the raw screen
        img = self.pyboy.screen.image
        return img.width, img.height

    # =========================================================================
    # Game State Reading (Pokemon Red/Blue specific)
    # =========================================================================

    def _read_byte(self, addr: int) -> int:
        """Read a single byte from memory."""
        return self.pyboy.memory[addr]

    def _read_word(self, addr: int) -> int:
        """Read a 16-bit word (little-endian) from memory."""
        return self.pyboy.memory[addr] | (self.pyboy.memory[addr + 1] << 8)

    def _read_word_be(self, addr: int) -> int:
        """Read a 16-bit word (big-endian) from memory."""
        return (self.pyboy.memory[addr] << 8) | self.pyboy.memory[addr + 1]

    def _decode_text(self, addr: int, length: int) -> str:
        """Decode Game Boy text encoding to string."""
        chars = []
        for i in range(length):
            byte = self.pyboy.memory[addr + i]
            if byte == 0x50:  # Terminator
                break
            elif 0x80 <= byte <= 0x99:  # A-Z
                chars.append(chr(ord('A') + (byte - 0x80)))
            elif 0xA0 <= byte <= 0xB9:  # a-z
                chars.append(chr(ord('a') + (byte - 0xA0)))
            elif 0xF6 <= byte <= 0xFF:  # 0-9
                chars.append(chr(ord('0') + (byte - 0xF6)))
            elif byte == 0x7F:
                chars.append(' ')
            elif byte == 0xE8:
                chars.append('♂')
            elif byte == 0xEF:
                chars.append('♀')
            else:
                chars.append('?')
        return ''.join(chars)

    def _decode_bcd(self, addr: int, num_bytes: int) -> int:
        """Decode BCD (Binary Coded Decimal) value."""
        result = 0
        for i in range(num_bytes):
            byte = self.pyboy.memory[addr + i]
            result = result * 100 + ((byte >> 4) * 10) + (byte & 0x0F)
        return result

    def get_badges(self) -> dict[str, Any]:
        """Get badge information."""
        badge_byte = self._read_byte(ADDR_BADGES)
        badges = {}
        for i, name in enumerate(BADGE_NAMES):
            badges[name.lower()] = bool(badge_byte & (1 << i))
        return {
            "count": bin(badge_byte).count('1'),
            "badges": badges
        }

    def get_party(self) -> list[dict[str, Any]]:
        """Get party Pokemon information."""
        party_count = self._read_byte(ADDR_PARTY_COUNT)
        party = []

        for i in range(min(party_count, 6)):
            species_id = self._read_byte(ADDR_PARTY_SPECIES + i)
            if species_id == 0 or species_id == 0xFF:
                continue

            # Read from full party data structure (44 bytes per Pokemon)
            base = ADDR_PARTY_DATA + (i * 44)

            # Read moves (4 bytes at offset 0x08)
            moves = []
            for m in range(4):
                move_id = self._read_byte(base + 0x08 + m)
                pp = self._read_byte(base + 0x1D + m)
                pp_current = pp & 0x3F  # Lower 6 bits
                if move_id > 0:
                    moves.append({
                        "name": MOVE_NAMES.get(move_id, f"Move {move_id}"),
                        "pp": pp_current
                    })

            # Get nickname
            nickname = self._decode_text(ADDR_PARTY_NICKNAMES + (i * 11), 11)

            pokemon = {
                "slot": i + 1,
                "species": POKEMON_NAMES.get(species_id, f"Pokemon {species_id}"),
                "species_id": species_id,
                "nickname": nickname,
                "level": self._read_byte(base + 0x21),
                "hp": self._read_word_be(base + 0x01),
                "max_hp": self._read_word_be(base + 0x22),
                "status": self._get_status_name(self._read_byte(base + 0x04)),
                "moves": moves
            }
            party.append(pokemon)

        return party

    def _get_status_name(self, status_byte: int) -> str:
        """Convert status byte to name."""
        if status_byte == 0:
            return "OK"
        elif status_byte & 0x08:
            return "Poisoned"
        elif status_byte & 0x10:
            return "Burned"
        elif status_byte & 0x20:
            return "Frozen"
        elif status_byte & 0x40:
            return "Paralyzed"
        elif status_byte & 0x07:
            return "Asleep"
        return "OK"

    def get_location(self) -> dict[str, Any]:
        """Get current location."""
        map_id = self._read_byte(ADDR_MAP_ID)
        return {
            "map_id": map_id,
            "name": MAP_NAMES.get(map_id, f"Unknown ({map_id})")
        }

    def get_money(self) -> int:
        """Get player's money."""
        return self._decode_bcd(ADDR_MONEY, 3)

    def get_play_time(self) -> dict[str, int]:
        """Get play time."""
        return {
            "hours": self._read_byte(ADDR_PLAY_TIME_HOURS),
            "minutes": self._read_byte(ADDR_PLAY_TIME_MINUTES),
            "seconds": self._read_byte(ADDR_PLAY_TIME_SECONDS)
        }

    def get_player_name(self) -> str:
        """Get player's name."""
        return self._decode_text(ADDR_PLAYER_NAME, 11)

    def get_game_state(self) -> dict[str, Any]:
        """Get complete game state for API."""
        return {
            "player": self.get_player_name(),
            "badges": self.get_badges(),
            "party": self.get_party(),
            "location": self.get_location(),
            "money": self.get_money(),
            "play_time": self.get_play_time(),
            "timestamp": int(time.time() * 1000)
        }
