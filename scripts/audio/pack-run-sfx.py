"""Renders the pack run's sound cues (public/audio/packs/run/*.mp3).

Each cue is recorded foley (cards, poker chips, wood, glass) layered with
sampled acoustic instruments (marimba, celesta, glockenspiel, harp,
pizzicato and bowed strings, timpani, orchestral cymbals), sequenced here as
MIDI and played through FluidSynth. The note and combo cues are single hits
the page pitches up a scale as the tally climbs, the trick that makes a
counting score feel good: tactile attack, a pitched body, and every hit a
step higher than the last.

Sources, both free to use:
  - GeneralUser GS 2.0 SoundFont (S. Christian Collins), whose license allows
    any use of music made with it: github.com/mrbumpy409/GeneralUser-GS
  - Kenney's Casino Audio, Impact Sounds and Interface Sounds packs, CC0:
    kenney.nl/assets

Setup and run:
    python -m venv /tmp/audio-venv
    /tmp/audio-venv/bin/pip install numpy scipy pedalboard
    /tmp/audio-venv/bin/python scripts/audio/pack-run-sfx.py \
        --soundfont GeneralUser-GS.sf2 --kenney <dir holding the unzipped packs> [--out dir]
Needs fluidsynth and ffmpeg on PATH.
"""

import argparse
import glob
import os
import struct
import subprocess
import tempfile

import numpy as np
from pedalboard import Compressor, HighpassFilter, Limiter, Pedalboard, Reverb
from scipy.io import wavfile

SR = 44100

# General MIDI programs (0-based) and percussion keys.
MARIMBA, XYLOPHONE, CELESTA, GLOCKENSPIEL, MUSIC_BOX, VIBRAPHONE, TUBULAR = 12, 13, 8, 9, 10, 11, 14
HARP, PIZZICATO, STRINGS, TIMPANI, CHOIR, KALIMBA = 46, 45, 48, 47, 52, 108
KICK, SIDE_STICK, CRASH, RIDE_BELL, HI_WOOD, LO_WOOD, CLAVES, TRIANGLE = 36, 37, 49, 53, 76, 77, 75, 81

E3, Gs3, B3, Cs4, E4, Fs4, Gs4, A4, B4, Cs5, Ds5, E5, Fs5, Gs5, A5, B5 = 52, 56, 59, 61, 64, 66, 68, 69, 71, 73, 75, 76, 78, 80, 81, 83


# ------------------------------------------------------------------ MIDI


def _varlen(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def write_midi(path, notes, programs):
    """notes: (start_s, channel, key, velocity, length_s). Tempo 120, so a
    tick is 1/960 s at 480 ticks a beat."""
    events = []
    for channel, program in programs.items():
        events.append((0, 0, bytes([0xC0 | channel, program])))
    for start, channel, key, velocity, length in notes:
        on = int(round(start * 960))
        off = int(round((start + length) * 960))
        events.append((on, 2, bytes([0x90 | channel, key, velocity])))
        events.append((off, 1, bytes([0x80 | channel, key, 0])))
    events.sort(key=lambda e: (e[0], e[1]))
    track = bytearray()
    track += _varlen(0) + bytes([0xFF, 0x51, 0x03]) + (500000).to_bytes(3, "big")
    last = 0
    for tick, _, data in events:
        track += _varlen(tick - last) + data
        last = tick
    track += _varlen(960) + bytes([0xFF, 0x2F, 0x00])
    with open(path, "wb") as handle:
        handle.write(b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480))
        handle.write(b"MTrk" + struct.pack(">I", len(track)) + track)


class Renderer:
    def __init__(self, soundfont, kenney, scratch):
        self.soundfont = soundfont
        self.kenney = kenney
        self.scratch = scratch
        self.count = 0

    def play(self, notes, programs, seconds):
        """Renders a MIDI sketch through FluidSynth, dry, as (2, samples)."""
        self.count += 1
        mid = os.path.join(self.scratch, f"cue{self.count}.mid")
        wav = os.path.join(self.scratch, f"cue{self.count}.wav")
        write_midi(mid, notes, programs)
        subprocess.run(
            ["fluidsynth", "-ni", "-q", "-R", "0", "-C", "0", "-g", "0.9", "-r", str(SR), "-F", wav, self.soundfont, mid],
            check=True,
            capture_output=True,
        )
        return fit(load(wav), seconds)

    def foley(self, name, seconds=None, start=0.0, gain=1.0):
        matches = glob.glob(os.path.join(self.kenney, "**", f"{name}.ogg"), recursive=True)
        if not matches:
            raise FileNotFoundError(name)
        audio = load(matches[0])
        audio = audio[:, int(start * SR):]
        if seconds is not None:
            audio = fit(audio, seconds)
        return audio * gain


def load(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def fit(audio, seconds):
    count = int(seconds * SR)
    if audio.shape[1] >= count:
        out = audio[:, :count].copy()
        fade = min(int(0.02 * SR), count)
        out[:, -fade:] *= np.linspace(1, 0, fade)
        return out
    return np.concatenate([audio, np.zeros((2, count - audio.shape[1]), dtype=audio.dtype)], axis=1)


def pitch(audio, semitones):
    """Resamples to shift pitch (and length), the way the page does."""
    ratio = 2 ** (semitones / 12)
    positions = np.arange(0, audio.shape[1] - 1, ratio)
    return np.stack([np.interp(positions, np.arange(audio.shape[1]), channel) for channel in audio])


def mix(seconds, *layers):
    """layers: (audio, at_seconds, gain)."""
    out = np.zeros((2, int(seconds * SR)), dtype=np.float32)
    for audio, at, gain in layers:
        start = int(at * SR)
        end = min(out.shape[1], start + audio.shape[1])
        if end > start:
            out[:, start:end] += audio[:, : end - start] * gain
    return out


def finish(audio, reverb=0.12, room=0.35, peak=0.68):
    board = Pedalboard([
        HighpassFilter(cutoff_frequency_hz=35),
        Reverb(room_size=room, damping=0.6, wet_level=reverb, dry_level=1.0, width=0.9),
        Compressor(threshold_db=-16, ratio=2.5, attack_ms=4, release_ms=90),
        Limiter(threshold_db=-2.0, release_ms=60),
    ])
    out = board(audio.astype(np.float32), SR)
    level = np.max(np.abs(out)) or 1.0
    out = out / level * peak
    # Trim the silent tail.
    loud = np.nonzero(np.max(np.abs(out), axis=0) > 10 ** (-58 / 20))[0]
    end = loud[-1] + int(0.02 * SR) if len(loud) else out.shape[1]
    out = out[:, :end]
    fade = min(int(0.03 * SR), out.shape[1])
    out[:, -fade:] *= np.linspace(1, 0, fade)
    return out


# ------------------------------------------------------------------- cues
# Key of E major. The page pitches note and combo up to 19 semitones, so
# they sit around E5 and stay sweet at the top.


def cue_note(r, variant):
    flick = r.foley("card-place-1" if variant == 1 else "card-place-3", 0.12)
    body = r.play([(0, 0, E5, 112, 0.18), (0, 1, E5 + 12, 52, 0.12)], {0: MARIMBA, 1: GLOCKENSPIEL if variant == 1 else CELESTA}, 0.45)
    return finish(mix(0.45, (flick, 0, 0.55), (body, 0.004, 1.0)), reverb=0.08)


def cue_combo(r):
    chips = r.foley("chips-stack-3", 0.35)
    body = r.play(
        [(0, 0, E5, 118, 0.2), (0, 0, B5, 100, 0.2), (0, 1, HI_WOOD, 110, 0.1), (0.0, 2, Gs5 + 12, 60, 0.15)],
        {0: XYLOPHONE, 2: GLOCKENSPIEL},
        0.55,
    )
    return finish(mix(0.55, (chips, 0, 0.8), (body, 0.006, 1.0)), reverb=0.1)


def cue_finish(r):
    glass = r.foley("impactGlass_heavy_001", 1.2)
    punch = r.foley("impactPunch_heavy_001", 0.6)
    body = r.play(
        [
            (0, 0, E3, 127, 0.9),
            (0, 9, CRASH, 110, 1.0),
            (0, 1, E5, 120, 1.2),
            (0, 1, B5, 105, 1.2),
            (0, 2, E5 + 12, 90, 0.8),
            (0.05, 2, Gs5 + 12, 80, 0.8),
            (0.1, 2, B5 + 12, 76, 0.8),
        ],
        {0: TIMPANI, 1: TUBULAR, 2: GLOCKENSPIEL},
        1.7,
    )
    return finish(mix(1.7, (punch, 0, 0.7), (glass, 0, 0.35), (body, 0, 1.0)), reverb=0.2, room=0.55)


def cue_miss(r):
    thud = pitch(r.foley("impactWood_light_002", 0.3), -5)
    body = r.play([(0, 0, B4, 100, 0.08), (0.07, 0, Fs4, 90, 0.08), (0.14, 0, Cs4, 80, 0.12)], {0: PIZZICATO}, 0.5)
    return finish(mix(0.5, (thud, 0, 0.8), (body, 0.01, 0.85)), reverb=0.06)


def cue_tick(r):
    body = r.play([(0, 9, CLAVES, 70, 0.03)], {}, 0.12)
    return finish(mix(0.12, (body, 0, 1.0)), reverb=0.0, peak=0.55)


def cue_slam(r):
    shower = r.foley("chips-collide-2", 0.4)
    stack = r.foley("chips-handle-4", 0.5)
    punch = r.foley("impactPunch_heavy_000", 0.7)
    body = r.play(
        [
            (0, 0, E3 - 12 + 12, 127, 0.7),
            (0, 9, KICK, 120, 0.2),
            (0, 9, CRASH, 96, 1.2),
            (0, 1, E4, 110, 0.6),
            (0, 1, B4, 100, 0.6),
            (0, 1, E5, 96, 0.6),
        ],
        {0: TIMPANI, 1: MARIMBA},
        1.3,
    )
    return finish(mix(1.3, (punch, 0, 0.65), (shower, 0.02, 0.5), (stack, 0.06, 0.45), (body, 0, 1.0)), reverb=0.16, room=0.5)


def cue_shards(r):
    coins = r.foley("chips-handle-1", 0.5)
    body = r.play([(0, 0, B5, 90, 0.3), (0.05, 0, E5 + 12, 92, 0.3), (0.1, 0, Gs5 + 12, 96, 0.4)], {0: CELESTA}, 0.8)
    return finish(mix(0.8, (coins, 0, 0.6), (body, 0, 1.0)), reverb=0.14)


def gliss(start, keys, step, channel, velocity=96, length=0.5):
    return [(start + index * step, channel, key, velocity, length) for index, key in enumerate(keys)]


SCALE_UP = [E4, Fs4, Gs4, A4, B4, Cs5, Ds5, E5, Fs5, Gs5, A5, B5, Cs5 + 12, Ds5 + 12, E5 + 12]


def cue_clear_song(r):
    coins = r.foley("chips-handle-3", 0.5)
    notes = gliss(0, SCALE_UP[4:13], 0.028, 0, 90, 0.6)
    notes += [(0.26, 1, E5, 104, 0.6), (0.26, 1, Gs5, 98, 0.6), (0.26, 1, B5, 98, 0.6), (0.26, 2, E5 + 12, 80, 0.7)]
    body = r.play(notes, {0: HARP, 1: MARIMBA, 2: CELESTA}, 1.3)
    return finish(mix(1.3, (body, 0, 1.0), (coins, 0.24, 0.45)), reverb=0.18, room=0.5)


def cue_clear_stage(r):
    coins = r.foley("chips-handle-6", 0.6)
    notes = gliss(0, SCALE_UP, 0.024, 0, 92, 0.8)
    beat = 0.14
    melody = [B4, E5, Gs5, B5]
    for index, key in enumerate(melody):
        notes.append((0.36 + index * beat, 1, key, 110, 0.12))
        notes.append((0.36 + index * beat, 2, key + 12, 70, 0.2))
    hit = 0.36 + len(melody) * beat
    notes += [
        (hit, 3, E4, 92, 1.0), (hit, 3, Gs4, 88, 1.0), (hit, 3, B4, 88, 1.0), (hit, 3, E5, 84, 1.0),
        (hit, 4, E3, 127, 0.9), (hit, 9, CRASH, 112, 1.2), (hit, 2, E5 + 12, 92, 0.9), (hit, 2, B5 + 12, 80, 0.9),
    ]
    for roll in range(8):
        notes.append((0.2 + roll * 0.03, 4, B3 - 12, 50 + roll * 8, 0.05))
    body = r.play(notes, {0: HARP, 1: PIZZICATO, 2: GLOCKENSPIEL, 3: STRINGS, 4: TIMPANI}, hit + 1.4)
    return finish(mix(hit + 1.4, (body, 0, 1.0), (coins, hit, 0.4)), reverb=0.22, room=0.6)


def cue_run_cleared(r):
    coins = r.foley("chips-collide-4", 0.5)
    notes = []
    # Timpani roll swelling into the downbeat.
    for roll in range(18):
        notes.append((roll * 0.035, 4, B3 - 12, 40 + roll * 4, 0.05))
    notes += gliss(0.1, SCALE_UP, 0.03, 0, 90, 0.9)
    beat = 0.16
    melody = [Gs5, B5, Cs5 + 12, B5, E5 + 12]
    start = 0.7
    for index, key in enumerate(melody):
        notes.append((start + index * beat, 1, key, 112, 0.18 if index < len(melody) - 1 else 1.0))
        notes.append((start + index * beat, 2, key + 12, 72, 0.3))
    hit = start + (len(melody) - 1) * beat
    chord = [E4, Gs4, B4, E5, Gs5]
    notes += [(start, 3, key, 70, hit - start) for key in [Cs4, E4, A4, Cs5]]
    notes += [(hit, 3, key, 100, 1.6) for key in chord]
    notes += [(hit, 5, key, 80, 1.6) for key in [Gs4, B4, E5]]
    notes += [(hit, 4, E3, 127, 1.0), (hit, 9, CRASH, 118, 2.0), (hit + 0.02, 9, TRIANGLE, 80, 1.0)]
    notes += gliss(hit + 0.1, [E5 + 12, Gs5 + 12, B5 + 12, E5 + 24], 0.07, 2, 70, 0.6)
    body = r.play(notes, {0: HARP, 1: VIBRAPHONE, 2: GLOCKENSPIEL, 3: STRINGS, 4: TIMPANI, 5: CHOIR}, hit + 2.2)
    return finish(mix(hit + 2.2, (body, 0, 1.0), (coins, hit, 0.45)), reverb=0.26, room=0.7)


def cue_run_failed(r):
    notes = []
    for index, key in enumerate([B4, Gs4, E4, Cs4]):
        notes.append((index * 0.2, 0, key, 100 - index * 6, 0.35 if index < 3 else 1.1))
        notes.append((index * 0.2, 1, key - 12, 70, 0.2))
    notes += [(0.6, 2, Cs4 - 12, 90, 1.2), (0.6, 2, Gs3 - 12, 80, 1.2), (0.6, 3, Cs4 - 24, 90, 0.8)]
    body = r.play(notes, {0: VIBRAPHONE, 1: PIZZICATO, 2: STRINGS, 3: TIMPANI}, 2.0)
    return finish(mix(2.0, (body, 0, 1.0)), reverb=0.24, room=0.65)


CUES = {
    "note-1": lambda r: cue_note(r, 1),
    "note-2": lambda r: cue_note(r, 2),
    "combo": cue_combo,
    "finish": cue_finish,
    "miss": cue_miss,
    "tick": cue_tick,
    "slam": cue_slam,
    "shards": cue_shards,
    "clear-song": cue_clear_song,
    "clear-stage": cue_clear_stage,
    "run-cleared": cue_run_cleared,
    "run-failed": cue_run_failed,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--soundfont", required=True)
    parser.add_argument("--kenney", required=True)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "public", "audio", "packs", "run"))
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch:
        renderer = Renderer(args.soundfont, args.kenney, scratch)
        for name, build in CUES.items():
            audio = np.asarray(build(renderer), dtype=np.float32)
            wav = os.path.join(scratch, f"{name}.wav")
            wavfile.write(wav, SR, audio.T)
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "128k", os.path.join(args.out, f"{name}.mp3")],
                check=True,
            )
            print(f"{name}: {audio.shape[1] / SR:.2f}s")


if __name__ == "__main__":
    main()
