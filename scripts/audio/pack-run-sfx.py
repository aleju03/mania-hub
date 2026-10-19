"""Renders the pack run's sound cues (public/audio/packs/run/*.mp3).

Every cue is recorded foley (cards, poker chips, coins, wood, glass, cloth,
impacts, fire) layered with sampled acoustic instruments (marimba, xylophone,
vibraphone, celesta, glockenspiel, harp, tubular bells, pizzicato and bowed
strings, timpani, orchestral cymbals), sequenced here as MIDI and played
through FluidSynth. numpy and pedalboard only mix and shape what those two
sources produce: trims, filters, envelopes, saturation, reverb, compression.
No tone is generated in code.

Two kinds of file:
  - single cues, played whole;
  - sprites, a row of fixed-length slots in one file. The scoring steps are
    sprites of four takes of one foley hit with a short damped note under it;
    the page raises the whole hit by playback rate as the chain grows, so the
    foley climbs with the note. Small cues that repeat (deal, flip, hover, count tick) are
    sprites of a few takes so back-to-back plays differ. Slot lengths and
    counts are mirrored in RUN_CUES in src/components/packs/packSfx.ts; change
    both together;
  - one loop, fire-loop, padded with 0.1 s of its own wrap on each side so
    the page can loop between FIRE_LOOP_PAD and FIRE_LOOP_PAD + its length.

Sources, all free to use (exact URLs in public/audio/packs/run/README.md):
  - GeneralUser GS 2.0 SoundFont (S. Christian Collins), whose license allows
    any use of music made with it: github.com/mrbumpy409/GeneralUser-GS
  - Kenney's Casino Audio, Impact Sounds and RPG Audio packs, CC0:
    kenney.nl/assets
  - Two CC0 fire recordings from OpenGameArt: "Fireplace Sound Loop" by
    PagDev (fire.wav) and "Fire Staff Sound Effects" by LEGIT Audio.

Setup and run:
    python -m venv /tmp/audio-venv
    /tmp/audio-venv/bin/pip install numpy scipy pedalboard
    /tmp/audio-venv/bin/python scripts/audio/pack-run-sfx.py \
        --soundfont GeneralUser-GS.sf2 --kenney <dir holding the unzipped packs and fire files> \
        [--out dir] [--only name,name]
Needs fluidsynth and ffmpeg on PATH. Bump RUN_SAMPLES_VERSION in packSfx.ts
after a re-render.
"""

import argparse
import glob
import os
import struct
import subprocess
import tempfile

import numpy as np
from pedalboard import Compressor, Gain, HighpassFilter, Limiter, Pedalboard, Reverb
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR = 44100

# General MIDI programs (0-based) and percussion keys.
MARIMBA, XYLOPHONE, CELESTA, GLOCKENSPIEL, MUSIC_BOX, VIBRAPHONE, TUBULAR = 12, 13, 8, 9, 10, 11, 14
HARP, PIZZICATO, STRINGS, TREMOLO, TIMPANI, CHOIR, KALIMBA = 46, 45, 48, 44, 47, 52, 108
TAIKO, REVERSE_CYMBAL, SEASHORE = 116, 119, 122
KICK, SIDE_STICK, CRASH, RIDE_BELL, HI_WOOD, LO_WOOD, CLAVES, TRIANGLE = 36, 37, 49, 53, 76, 77, 75, 81

E1, E2, B2, E3, Gs3, B3, Cs4, E4, Fs4, Gs4, A4, B4, Cs5, Ds5, E5, Fs5, Gs5, A5, B5 = (
    28, 40, 47, 52, 56, 59, 61, 64, 66, 68, 69, 71, 73, 75, 76, 78, 80, 81, 83,
)

# Seconds of wrap-around padding on each side of the fire loop.
FIRE_LOOP_PAD = 0.1
FIRE_LOOP_SECONDS = 6.0


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
        self.cache = {}

    def play(self, notes, programs, seconds):
        """Renders a MIDI sketch through FluidSynth, dry, peak-normalised, as
        (2, samples)."""
        self.count += 1
        mid = os.path.join(self.scratch, f"cue{self.count}.mid")
        wav = os.path.join(self.scratch, f"cue{self.count}.wav")
        write_midi(mid, notes, programs)
        subprocess.run(
            ["fluidsynth", "-ni", "-q", "-R", "0", "-C", "0", "-g", "0.9", "-r", str(SR), "-F", wav, self.soundfont, mid],
            check=True,
            capture_output=True,
        )
        return norm(fit(load(wav), seconds))

    def foley(self, name, seconds=None, skip=0.0, trim=True, onset=0.08, need=False):
        """A recording, peak-normalised, never padded. `trim` cuts the silence
        before its first transient (most of the takes open with 30-400 ms of
        room), so a layer placed at 0 s sounds at 0 s. `onset` is the share of
        the peak that counts as the transient; the card-place takes need ~0.45
        to skip the slide that comes before their snap. `seconds` cuts the take
        to at most that long; a one-shot that ends sooner is returned as it is
        (the mix it goes into has the room). Digital silence at the end of a
        file does not count as the take. `need` makes a short take an error:
        beds and loops, which must really hold sound for `seconds`."""
        if name not in self.cache:
            matches = glob.glob(os.path.join(self.kenney, "**", f"{glob.escape(name)}.ogg"), recursive=True)
            matches += glob.glob(os.path.join(self.kenney, "**", f"{glob.escape(name)}.wav"), recursive=True)
            if not matches:
                raise FileNotFoundError(name)
            audio = load(matches[0])
            loud = np.nonzero(np.max(np.abs(audio), axis=0) > 10 ** (-80 / 20))[0]
            self.cache[name] = audio[:, : loud[-1] + 1] if len(loud) else audio
        audio = self.cache[name]
        if trim:
            mono = np.max(np.abs(audio), axis=0)
            first = int(np.argmax(mono > np.max(mono) * onset))
            audio = audio[:, max(0, first - int(0.002 * SR)):]
        audio = audio[:, int(skip * SR):]
        if seconds is not None:
            if audio.shape[1] < int(seconds * SR):
                if need:
                    raise ValueError(f"{name}: {seconds}s asked from {skip}s, the take holds {audio.shape[1] / SR:.2f}s")
            else:
                audio = fit(audio, seconds)
        return norm(audio)


def load(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def norm(audio):
    level = np.max(np.abs(audio)) or 1.0
    return (audio / level).astype(np.float32)


def fit(audio, seconds, fade=0.02):
    count = int(seconds * SR)
    if audio.shape[1] >= count:
        out = audio[:, :count].copy()
        fade = min(int(fade * SR), count)
        out[:, -fade:] *= np.linspace(1, 0, fade)
        return out
    return np.concatenate([audio, np.zeros((2, count - audio.shape[1]), dtype=audio.dtype)], axis=1)


def pitch(audio, semitones):
    """Resamples to shift pitch (and length), the way the page does."""
    ratio = 2 ** (semitones / 12)
    positions = np.arange(0, audio.shape[1] - 1, ratio)
    return np.stack([np.interp(positions, np.arange(audio.shape[1]), channel) for channel in audio]).astype(np.float32)


def lowpass(audio, hz, order=2):
    return sosfilt(butter(order, hz, "low", fs=SR, output="sos"), audio, axis=1).astype(np.float32)


def highpass(audio, hz, order=2):
    return sosfilt(butter(order, hz, "high", fs=SR, output="sos"), audio, axis=1).astype(np.float32)


def crunch(audio, drive=2.5):
    """Soft-clips a layer so its transient grits up instead of just getting
    louder, the 'crunch' of a chip or a tick."""
    return (np.tanh(audio * drive) / np.tanh(drive)).astype(np.float32)


def decay(audio, seconds):
    """Exponential fade from the start, to shorten a take's tail."""
    t = np.arange(audio.shape[1]) / SR
    return (audio * np.exp(-t / seconds)).astype(np.float32)


def swell(audio, attack, hold, release):
    """Fade in over `attack`, hold, fade out over `release` (seconds)."""
    n = audio.shape[1]
    shape = np.ones(n, dtype=np.float32)
    a = min(n, int(attack * SR))
    shape[:a] = np.linspace(0, 1, a) ** 2
    start = int((attack + hold) * SR)
    if start < n:
        r = min(n - start, int(release * SR))
        shape[start:start + r] = np.linspace(1, 0, r) ** 1.5
        shape[start + r:] = 0
    return (audio * shape).astype(np.float32)


def mix(seconds, *layers):
    """layers: (audio, at_seconds, gain)."""
    out = np.zeros((2, int(seconds * SR)), dtype=np.float32)
    for audio, at, gain in layers:
        start = int(at * SR)
        end = min(out.shape[1], start + audio.shape[1])
        if end > start:
            out[:, start:end] += audio[:, : end - start] * gain
    return out


def finish(audio, reverb=0.12, room=0.35, peak=0.68, punch=False, trim=True, drive=0.0):
    """Room, glue and level. `punch` uses a slower-attack, harder compressor
    so a hit's transient pokes out ahead of its body. `drive` pushes that many
    dB into the limiter, shaving the first milliseconds of the transient so
    the body around it can sit louder: how a hit is made to weigh more than a
    peakier one at the same peak level."""
    compressor = (
        Compressor(threshold_db=-20, ratio=4, attack_ms=12, release_ms=120)
        if punch
        else Compressor(threshold_db=-16, ratio=2.5, attack_ms=4, release_ms=90)
    )
    board = Pedalboard([
        HighpassFilter(cutoff_frequency_hz=32),
        Reverb(room_size=room, damping=0.6, wet_level=reverb, dry_level=1.0, width=0.9),
        compressor,
        Gain(gain_db=drive),
        Limiter(threshold_db=-1.5, release_ms=60),
    ])
    out = board(audio.astype(np.float32), SR)
    level = np.max(np.abs(out)) or 1.0
    out = out / level * peak
    if trim:
        loud = np.nonzero(np.max(np.abs(out), axis=0) > 10 ** (-58 / 20))[0]
        end = loud[-1] + int(0.02 * SR) if len(loud) else out.shape[1]
        out = out[:, :end]
    fade = min(int(0.03 * SR), out.shape[1])
    out[:, -fade:] *= np.linspace(1, 0, fade)
    return out.astype(np.float32)


class Sprite:
    """Slots of a fixed length laid end to end. Each take is cut to the slot
    minus a 60 ms silent margin, so a decoder that keeps the mp3's few ms of
    encoder delay never lets one slot bleed into the next."""

    def __init__(self, slot, takes):
        self.slot = slot
        self.takes = takes

    def render(self):
        room = self.slot - 0.06
        parts = [fit(fit(take, room, fade=0.04), self.slot) for take in self.takes]
        return np.concatenate(parts, axis=1)


def gliss(start, keys, step, channel, velocity=96, length=0.5):
    return [(start + index * step, channel, key, velocity, length) for index, key in enumerate(keys)]


# Onset share for card snaps (see Renderer.foley).
SNAP = 0.45

CHIP_CLINKS = ["chips-collide-1", "chips-collide-2", "chips-collide-3", "chips-collide-4"]
CHIP_STACKS = ["chips-stack-1", "chips-stack-2", "chips-stack-3", "chips-stack-4", "chips-stack-5", "chips-stack-6"]


# ------------------------------------------------------------- the table


def cue_pack_open(r):
    """The pack torn open on the table: foil tear, cards sliding out, a soft
    thump of the pack on felt, a short harp and celesta lift."""
    tear = r.foley("cards-pack-open-1", 0.45)
    out = r.foley("cards-pack-take-out-1", 0.4)
    thump = lowpass(r.foley("impactSoft_medium_001", 0.35), 900)
    body = r.play(
        gliss(0.1, [B4, E5, Gs5, B5], 0.045, 0, 70, 0.4) + gliss(0.12, [E5 + 12, Gs5 + 12], 0.06, 1, 46, 0.3),
        {0: HARP, 1: CELESTA},
        0.9,
    )
    return finish(mix(0.95, (thump, 0, 0.55), (tear, 0.005, 0.8), (out, 0.16, 0.5), (body, 0.0, 0.45)), reverb=0.1)


def deal_take(r, slide, place):
    """One card dealt: a short slide, the snap of it landing, a little table
    weight under the snap."""
    swish = highpass(r.foley(slide, 0.14), 1200)
    snap = r.foley(place, 0.18, onset=SNAP)
    weight = lowpass(r.foley("impactWood_light_003", 0.12), 700)
    return finish(mix(0.3, (swish, 0, 0.35), (snap, 0.035, 1.0), (weight, 0.035, 0.35)), reverb=0.05, peak=0.7)


def cue_deal(r):
    return Sprite(0.3, [
        deal_take(r, "card-slide-1", "card-place-1"),
        deal_take(r, "card-slide-5", "card-place-2"),
        deal_take(r, "card-slide-6", "card-place-4"),
    ])


def flip_take(r, paper):
    """A card turned face up: a paper flick and a card snap, 120 ms, with a
    faint celesta tink about 10 dB under them that the page pitches up across
    the hand."""
    flick = highpass(r.foley(paper, 0.12), 900)
    snap = r.foley("card-place-2", 0.09, onset=SNAP)
    tink = r.play([(0, 0, B5, 52, 0.08)], {0: CELESTA}, 0.1)
    return finish(mix(0.12, (flick, 0, 0.8), (snap, 0.015, 0.6), (tink, 0.015, 0.11)), reverb=0.03, peak=0.64)


def cue_flip(r):
    return Sprite(0.18, [flip_take(r, "bookFlip3"), flip_take(r, "bookFlip2"), flip_take(r, "card-shove-3")])


def hover_take(r, name):
    """A finger brushing a card: a soft rub, dark and short."""
    rub = decay(lowpass(r.foley(name, 0.16), 4200), 0.07)
    return finish(mix(0.2, (rub, 0, 1.0)), reverb=0.0, peak=0.5)


def cue_hover(r):
    return Sprite(0.2, [hover_take(r, "card-slide-5"), hover_take(r, "cloth4"), hover_take(r, "card-slide-6")])


# ---------------------------------------------------------- scoring chain
# Each step type is a few takes of one foley hit with a short damped note under
# it, all at one base pitch. The page raises the whole hit by playback rate as
# the chain grows (runSound.ts), so the clinks, knocks and the note climb
# together, the way the reference does it. Takes rotate so a run of the same
# step never repeats a recording back to back.

CHAIN_TAKES = 4

# Peak level of each step's takes, which is what sets the chain's order: the
# page plays every step at the same gain. Measured (EBU momentary max and 50 ms
# punch, full range and after a 200 Hz high-pass, per step over a 13-step
# chain): combo about 1 LU over notes with 4 dB more punch, multiplier at
# least 2 LU over combo after the high-pass, again and charm level with notes.
STEP_PEAK = {"notes": 0.48, "combo": 0.84, "multiplier": 0.67, "again": 0.41, "charm": 0.46}


def tock(audio, seconds=0.05):
    return decay(audio, seconds)


def step_notes_take(r, index):
    """Notes (the blue step): a card flick, a chip clink and a chip rattle,
    gritted, with a marimba tick far under them."""
    flick = crunch(lowpass(r.foley("card-place-2" if index % 2 else "card-place-1", 0.1, onset=SNAP), 7000), 2.0)
    chip = crunch(highpass(r.foley(CHIP_CLINKS[index % 4], 0.22), 600), 2.5)
    rattle = highpass(r.foley(["chips-handle-3", "chips-handle-4", "chips-handle-3", "chips-handle-4"][index], 0.25), 600)
    body = tock(r.play([(0, 0, E5, 96, 0.15)], {0: MARIMBA}, 0.3), 0.03)
    return finish(
        mix(0.42, (flick, 0, 0.9), (chip, 0.002, 1.0), (rattle, 0.02, 0.9), (body, 0.004, 0.06)),
        reverb=0.07, peak=STEP_PEAK["notes"], punch=True, trim=False, drive=10,
    )


def step_combo_take(r, index):
    """Combo (the red step): a chip stack slapped down hard with a wood knock
    and a wood block on the same instant, a second clink just after, a damped
    xylophone fifth under them. No rattle tail and no limiter drive, so its
    slap is the sharpest hit of the chain."""
    chips = crunch(r.foley(CHIP_STACKS[[0, 2, 3, 5][index]], 0.18), 2.5)
    clink = crunch(highpass(r.foley(CHIP_CLINKS[(index + 2) % 4], 0.12), 1200), 2.5)
    knock = decay(lowpass(r.foley(f"impactWood_light_00{index}", 0.12), 3000), 0.04)
    block = decay(r.play([(0, 9, HI_WOOD, 120, 0.06)], {}, 0.15), 0.04)
    body = tock(r.play([(0, 0, B4, 110, 0.2), (0, 0, Fs5, 92, 0.2)], {0: XYLOPHONE}, 0.4), 0.04)
    return finish(
        mix(
            0.5, (chips, 0, 1.0), (clink, 0.018, 0.5), (knock, 0, 1.0), (block, 0, 0.8), (body, 0.004, 0.3),
        ),
        reverb=0.05, peak=STEP_PEAK["combo"], trim=False,
    )


def step_multiplier_take(r, index):
    """Multiplier (the heavier red step): a chip-stack slap and a low wood
    block at the front, so it out-punches combo from the first 50 ms, then
    its weight in the mids like the slam: a fist on wood doubled a fourth
    down, a book slap, a plank and a punch, chips grabbed in the hand, with a
    damped marimba octave and a soft timpani under them."""
    punch = highpass(lowpass(r.foley(f"impactPunch_medium_00{index}", 0.3), 4000), 200)
    fist = highpass(lowpass(r.foley(f"impactWood_heavy_00{index}", 0.3), 2000), 180)
    book = lowpass(r.foley(f"bookPlace{index % 3 + 1}", 0.25), 4000)
    plank = highpass(lowpass(r.foley(f"impactPlank_medium_00{index}", 0.3), 2500), 200)
    chips = crunch(r.foley("chips-handle-3", 0.22), 2.0)
    slap = crunch(r.foley(CHIP_STACKS[[1, 3, 4, 0][index]], 0.16), 2.5)
    block = decay(r.play([(0, 9, LO_WOOD, 124, 0.06)], {}, 0.15), 0.05)
    timpani = r.play([(0, 0, E3, 104, 0.4)], {0: TIMPANI}, 0.55)
    body = tock(r.play([(0, 0, E4, 110, 0.3), (0, 0, E5, 96, 0.3)], {0: MARIMBA}, 0.55), 0.08)
    mid = mix(
        0.6, (fist, 0, 1.0), (pitch(fist, -4.75), 0.05, 0.7), (book, 0.0, 0.8), (plank, 0.01, 0.6), (punch, 0, 0.8),
    )
    return finish(
        mix(
            0.6, (crunch(mid, 1.5), 0, 1.0), (slap, 0, 0.9), (block, 0, 0.8), (chips, 0.012, 0.5),
            (timpani, 0, 0.12), (body, 0.0, 0.3),
        ),
        reverb=0.12, room=0.45, peak=STEP_PEAK["multiplier"], punch=True, trim=False, drive=2,
    )


def step_again_take(r, index):
    """Again (a card that scores twice): the card slapped twice, the second
    harder and with a chip clink and rattle, a damped marimba note struck
    twice under them."""
    tap = crunch(r.foley("card-place-1" if index % 2 else "card-place-3", 0.1, onset=SNAP), 2.0)
    clink = crunch(highpass(r.foley(CHIP_CLINKS[index % 4], 0.22), 600), 2.5)
    rattle = highpass(r.foley("chips-handle-4", 0.3), 600)
    body = tock(r.play([(0, 0, E5, 84, 0.12), (0.075, 0, E5, 112, 0.22)], {0: MARIMBA}, 0.45), 0.07)
    return finish(
        mix(
            0.5, (tap, 0, 0.65), (tap, 0.075, 1.0), (clink, 0.077, 0.9), (rattle, 0.085, 0.45),
            (body, 0.003, 0.32),
        ),
        reverb=0.08, peak=STEP_PEAK["again"], punch=True, trim=False, drive=6,
    )


def charm_fire_take(r, index):
    """A charm firing (the orange step): its card shoved on the rail, a glass
    tap and a chip laid down, with damped vibraphone and celesta under them."""
    shove = crunch(highpass(r.foley("card-shove-1" if index % 2 else "card-shove-4", 0.2, onset=SNAP), 600), 2.0)
    glass = highpass(r.foley(f"impactGlass_light_00{index}", 0.22), 900)
    chip = r.foley("chip-lay-3", 0.2)
    rattle = highpass(r.foley("chips-handle-3", 0.22), 600)
    body = tock(r.play([(0, 0, B5, 100, 0.25), (0, 1, B5 + 12, 56, 0.25)], {0: VIBRAPHONE, 1: CELESTA}, 0.45), 0.07)
    return finish(
        mix(
            0.5, (shove, 0, 0.8), (glass, 0.004, 1.0), (chip, 0.01, 0.6), (rattle, 0.02, 0.4),
            (body, 0.004, 0.45),
        ),
        reverb=0.12, peak=STEP_PEAK["charm"], punch=True, trim=False,
    )


def check_single_hit(audio, name, after=0.12, margin_db=8.0):
    """A chain step is one hit: no 10 ms window after `after` may come
    within `margin_db` of the take's peak, or it reads as an extra beat."""
    mono = np.max(np.abs(audio), axis=0)
    peak = mono.max()
    step = int(0.01 * SR)
    start = int(after * SR)
    late = max((mono[i:i + step].max() for i in range(start, len(mono) - step + 1, step)), default=0.0)
    gap = 20 * np.log10(peak / max(late, 1e-9))
    if gap < margin_db:
        raise ValueError(f"{name}: a hit {gap:.1f} dB under the peak after {after * 1000:.0f} ms")


def tame_tail(audio, after=0.11, margin_db=10.0):
    """Holds everything after `after` at least `margin_db` under the take's
    peak with a fast gain ride (5 ms look, 3 ms smoothing), so a rattle's late
    clink or a limiter-flattened body can never read as a second hit."""
    mono = np.max(np.abs(audio), axis=0)
    limit = mono.max() * 10 ** (-margin_db / 20)
    look = int(0.005 * SR)
    env = np.array([mono[i:i + look].max() for i in range(len(mono))])
    gain = np.minimum(1.0, limit / np.maximum(env, 1e-9))
    start = int(after * SR)
    ramp = np.clip((np.arange(len(mono)) - (start - int(0.01 * SR))) / int(0.01 * SR), 0, 1)
    gain = 1 - ramp * (1 - gain)
    kernel = np.ones(int(0.003 * SR)) / int(0.003 * SR)
    gain = np.minimum(gain, np.convolve(gain, kernel, mode="same"))
    return (audio * gain).astype(np.float32)


def chain_sprite(take, slot):
    def build(r):
        takes = [tame_tail(take(r, index)) for index in range(CHAIN_TAKES)]
        for index, audio in enumerate(takes):
            check_single_hit(audio, f"{take.__name__} {index}")
        return Sprite(slot, takes)
    return build


def cue_step_miss(r):
    """A card a mod zeroed: a dull wood knock doubled a fourth down (a thicker
    thud), with two falling pizzicato notes."""
    knock = lowpass(r.foley("impactWood_medium_001", 0.25), 1600)
    low = pitch(knock, -4.75)
    body = r.play([(0, 0, B3, 92, 0.08), (0.08, 0, Fs4 - 12, 82, 0.12)], {0: PIZZICATO}, 0.45)
    return finish(mix(0.5, (knock, 0, 0.9), (low, 0.06, 0.65), (body, 0.01, 0.55)), reverb=0.06, peak=0.66)


def cue_finish(r):
    """The chain done: a card shoved home, a chip stack slapped down and a
    wood click, with a damped E major marimba chord far under them (about
    10 dB), the full stop before the total lands."""
    shove = r.foley("card-shove-2", 0.2, onset=SNAP)
    slap = crunch(r.foley("chips-stack-3", 0.25), 2.0)
    click = decay(r.play([(0, 9, HI_WOOD, 112, 0.06)], {}, 0.15), 0.04)
    knock = lowpass(r.foley("impactWood_light_002", 0.15), 3000)
    chord = tock(r.play([(0, 0, k, 100, 0.4) for k in [E4, Gs4, B4, E5]], {0: MARIMBA}, 0.6), 0.12)
    return finish(
        mix(0.6, (shove, 0, 0.8), (slap, 0.01, 1.0), (click, 0.01, 0.7), (knock, 0.01, 0.6), (chord, 0.012, 0.3)),
        reverb=0.1, room=0.4, peak=0.7, punch=True,
    )


# ----------------------------------------------------------- count + slam


def tick_take(r, name, wood):
    """One notch of the score rolling: a chip clink cut to 40 ms and gritted,
    over a wood block, dry."""
    chip = decay(crunch(highpass(r.foley(name, 0.05), 900), 3.0), 0.018)
    block = r.play([(0, 9, wood, 64, 0.03)], {}, 0.06)
    block = decay(block, 0.02)
    return finish(mix(0.07, (chip, 0, 0.75), (block, 0, 0.55)), reverb=0.0, peak=0.6, trim=False)


def cue_count_tick(r):
    return Sprite(0.1, [
        tick_take(r, "chip-lay-1", HI_WOOD),
        tick_take(r, "chips-collide-2", CLAVES),
        tick_take(r, "chip-lay-2", HI_WOOD),
        tick_take(r, "chips-stack-2", CLAVES),
    ])


def cue_slam(r):
    """The total landing. The weight a laptop speaker can play sits in the
    mids: a fist on wood doubled a fourth down, a book slapped flat, a plank
    and a heavy punch, over a low marimba chord. Under that a timpani, a kick
    and a soft low impact; on top a chip shower and a short crash."""
    punch = lowpass(r.foley("impactPunch_heavy_000", 0.5), 5000)
    fist = lowpass(r.foley("impactWood_heavy_002", 0.3), 2000)
    knock = lowpass(r.foley("impactWood_medium_003", 0.3), 2500)
    book = lowpass(r.foley("bookPlace2", 0.3), 4000)
    plank = lowpass(r.foley("impactPlank_medium_001", 0.4), 2500)
    body_low = lowpass(r.foley("impactSoft_heavy_001", 0.5), 300)
    shower = r.foley("chips-collide-2", 0.25)
    stack = r.foley("chips-handle-4", 0.36)
    low = r.play([(0, 0, E2, 127, 0.7), (0, 9, KICK, 120, 0.2)], {0: TIMPANI}, 1.1)
    chord = r.play([(0, 0, k, v, 0.6) for k, v in [(E3, 127), (B3, 120), (E4, 116), (Gs4, 104)]], {0: MARIMBA}, 1.1)
    crash_tail = lowpass(r.play([(0, 9, CRASH, 90, 0.6)], {}, 1.0), 7000)
    mid = highpass(mix(
        1.15,
        (fist, 0, 1.0), (pitch(fist, -4.75), 0.06, 0.7), (knock, 0.004, 0.7), (book, 0.0, 0.8),
        (plank, 0.01, 0.6), (punch, 0, 0.9),
    ), 130)
    return finish(
        mix(
            1.15,
            (crunch(mid, 1.6), 0, 1.0), (chord, 0, 0.6), (low, 0, 0.3), (body_low, 0, 0.12),
            (shower, 0.025, 0.45), (stack, 0.07, 0.35), (crash_tail, 0.0, 0.2),
        ),
        reverb=0.14, room=0.5, peak=0.85, punch=True, drive=9,
    )


def cue_slam_heavy(r):
    """Weight the page lays under the slam, from a floor up to full as the
    pack covers more of the song: a taiko, a timpani and a low string stab
    under a second, deeper impact and a plank."""
    thud = lowpass(pitch(r.foley("impactSoft_heavy_003", 0.55), -5), 300)
    plank = lowpass(r.foley("impactPlank_medium_001", 0.4), 2000)
    fist = lowpass(pitch(r.foley("impactWood_heavy_001", 0.3), -3), 1500)
    drums = r.play([(0, 0, E2, 127, 0.8), (0, 1, E2, 127, 0.9), (0, 9, CRASH, 96, 1.2)], {0: TAIKO, 1: TIMPANI}, 1.4)
    stab = r.play([(0, 0, E2, 118, 0.28), (0, 0, E3, 112, 0.28), (0, 0, B3, 100, 0.28)], {0: STRINGS}, 1.0)
    return finish(
        mix(1.4, (thud, 0, 0.6), (plank, 0, 0.8), (fist, 0.03, 0.9), (drums, 0, 1.0), (stab, 0, 0.45)),
        reverb=0.2, room=0.6, peak=0.8, punch=True, drive=6,
    )


FIRE_BURST = "LEGIT_FIR_Fire_Staff 8-Audio"
FIRE_ROAR = "LEGIT_FIR_Fire_Staff 25-Audio"
FIRE_CRACKLE = "fire"


def cue_fire_ignite(r):
    """The score area catching fire: a recorded fire burst for the catch, a
    timpani hit and a card riffle an octave down under it, then a recorded
    flame roar swelling and settling with fireplace crackle on top."""
    burst = r.foley(FIRE_BURST, 1.2)
    roar = swell(lowpass(r.foley(FIRE_ROAR, 2.0, skip=1.0, trim=False), 3500), 0.12, 0.4, 1.3)
    crackle = swell(highpass(r.foley(FIRE_CRACKLE, 2.0, skip=3.0, trim=False), 1500), 0.2, 0.6, 1.0)
    rush = lowpass(pitch(r.foley("card-fan-1", 0.7), -12), 2500)
    body = r.play([(0, 0, E2, 112, 0.6)] + [(0.3 + i * 0.05, 0, E2, 44 - i * 2, 0.05) for i in range(10)], {0: TIMPANI}, 1.6)
    return finish(
        mix(2.0, (burst, 0, 1.0), (rush, 0, 0.35), (roar, 0.05, 0.75), (crackle, 0.1, 0.5), (body, 0, 0.55)),
        reverb=0.14, room=0.5, peak=0.78,
    )


def cue_fire_loop(r):
    """The flame while the score stays over target: the recorded roar, darker,
    with the fireplace crackle on top, levelled so it holds steady. Built
    circular (its end crossfades into its start) and padded with its own wrap
    so the page loops it seamlessly. Fails the render if any 100 ms of the
    loop strays more than 3 dB from the median."""
    fade = 0.5
    total = FIRE_LOOP_SECONDS + fade
    roar = lowpass(r.foley(FIRE_ROAR, total, skip=2.0, trim=False, need=True), 2500)
    crackle = highpass(r.foley(FIRE_CRACKLE, total, skip=8.0, trim=False, need=True), 1200)
    board = Pedalboard([HighpassFilter(cutoff_frequency_hz=60), Compressor(threshold_db=-18, ratio=3, attack_ms=10, release_ms=200)])
    body = level_out(board(mix(total, (roar, 0, 0.8), (crackle, 0, 0.55)), SR))
    n, x = int(FIRE_LOOP_SECONDS * SR), int(fade * SR)
    loop = body[:, :n].copy()
    ramp = np.sin(np.linspace(0, np.pi / 2, x)) ** 2
    loop[:, :x] = loop[:, :x] * ramp + body[:, n:n + x] * (1 - ramp)
    check_steady(np.concatenate([loop, loop[:, : int(0.5 * SR)]], axis=1), "fire-loop")
    pad = int(FIRE_LOOP_PAD * SR)
    out = np.concatenate([loop[:, -pad:], loop, loop[:, :pad]], axis=1)
    return (norm(out) * 0.6).astype(np.float32)


def level_out(audio, window=0.3):
    """Rides a bed's level toward its median over `window`-long stretches (a
    slow gain ride, the way a mixer would hold a background steady)."""
    mono = np.mean(audio, axis=0)
    hop = int(0.05 * SR)
    frames = np.array([np.sqrt(np.mean(mono[i:i + int(window * SR)] ** 2)) + 1e-9 for i in range(0, len(mono), hop)])
    target = np.median(frames)
    gain = np.clip(target / frames, 0.4, 2.5)
    curve = np.interp(np.arange(len(mono)), np.arange(len(frames)) * hop + int(window * SR) / 2, gain)
    return (audio * curve).astype(np.float32)


def check_steady(audio, name, window=0.1, spread=3.0):
    mono = np.mean(audio, axis=0)
    step = int(window * SR)
    levels = np.array([20 * np.log10(np.sqrt(np.mean(mono[i:i + step] ** 2)) + 1e-9) for i in range(0, len(mono) - step + 1, step)])
    off = np.abs(levels - np.median(levels))
    if off.max() > spread:
        raise ValueError(f"{name}: a {window * 1000:.0f} ms window sits {off.max():.1f} dB off the median")
    print(f"{name}: every {window * 1000:.0f} ms window within {off.max():.1f} dB of the median")


# ------------------------------------------------------------- song end


def cue_tally_line(r):
    """One tally line counting in: a low wood click and a chip with a marimba
    note and a quiet celesta a fifth above; the page climbs it per line."""
    chip = r.foley("chip-lay-3", 0.15)
    body = r.play([(0, 9, LO_WOOD, 100, 0.06), (0, 0, B4, 100, 0.3), (0, 1, Fs5, 44, 0.25)], {0: MARIMBA, 1: CELESTA}, 0.45)
    return finish(mix(0.45, (chip, 0, 0.45), (body, 0.002, 1.0)), reverb=0.1, peak=0.68)


def cue_tally_total(r):
    """The tally total landing: coins in the hand and a book-flat thunk under
    an E major marimba chord, glockenspiel and a soft timpani."""
    coins = r.foley("handleCoins", 0.6)
    chips = r.foley("chips-handle-1", 0.4)
    thunk = lowpass(r.foley("bookPlace2", 0.25), 3500)
    body = r.play(
        [(0, 0, k, 112, 0.7) for k in [E4, Gs4, B4, E5]]
        + gliss(0.02, [E5 + 12, Gs5 + 12, B5 + 12], 0.05, 1, 70, 0.5)
        + [(0, 2, E2, 96, 0.6), (0, 9, CRASH, 52, 0.8)],
        {0: MARIMBA, 1: GLOCKENSPIEL, 2: TIMPANI},
        1.3,
    )
    return finish(mix(1.3, (thunk, 0, 0.7), (coins, 0.01, 0.5), (chips, 0.04, 0.35), (body, 0.003, 1.0)), reverb=0.18, room=0.5, peak=0.76)


SCALE_UP = [E4, Fs4, Gs4, A4, B4, Cs5, Ds5, E5, Fs5, Gs5, A5, B5, Cs5 + 12, Ds5 + 12, E5 + 12]


def cue_clear_song(r):
    coins = r.foley("chips-handle-3", 0.5)
    notes = gliss(0, SCALE_UP[4:13], 0.028, 0, 90, 0.6)
    notes += [(0.26, 1, E5, 104, 0.6), (0.26, 1, Gs5, 98, 0.6), (0.26, 1, B5, 98, 0.6), (0.26, 2, E5 + 12, 80, 0.7)]
    body = r.play(notes, {0: HARP, 1: MARIMBA, 2: CELESTA}, 1.3)
    return finish(mix(1.3, (body, 0, 1.0), (coins, 0.24, 0.4)), reverb=0.18, room=0.5)


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
    return finish(mix(hit + 1.4, (body, 0, 1.0), (coins, hit, 0.35)), reverb=0.22, room=0.6)


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
    return finish(mix(hit + 2.2, (body, 0, 1.0), (coins, hit, 0.4)), reverb=0.26, room=0.7)


def cue_run_failed(r):
    """A failed run: a dull low knock at half pitch, doubled a fourth further
    down 60 ms later, and a card riffle dropped an octave as a whoosh, with a
    falling vibraphone line, low strings and soft timpani kept under them."""
    knock = lowpass(pitch(r.foley("impactWood_heavy_001", 0.35), -12), 900)
    second = lowpass(pitch(r.foley("impactWood_heavy_003", 0.35), -16.75), 800)
    whoosh = lowpass(pitch(r.foley("card-fan-1", 0.7), -12), 2000)
    notes = []
    for index, key in enumerate([B4, Gs4, E4, Cs4]):
        notes.append((0.25 + index * 0.2, 0, key, 92 - index * 6, 0.35 if index < 3 else 1.1))
        notes.append((0.25 + index * 0.2, 1, key - 12, 64, 0.2))
    notes += [(0.85, 2, Cs4 - 12, 84, 1.1), (0.85, 2, Gs3 - 12, 76, 1.1), (0, 3, Cs4 - 24, 100, 0.8)]
    body = r.play(notes, {0: VIBRAPHONE, 1: PIZZICATO, 2: STRINGS, 3: TIMPANI}, 2.2)
    return finish(
        mix(2.2, (knock, 0, 1.0), (second, 0.06, 0.8), (whoosh, 0.02, 0.45), (body, 0, 0.5)),
        reverb=0.22, room=0.6, peak=0.62, punch=True,
    )


def shard_token_take(r, coin, chip):
    """One shard landing in the wallet: a coin and a chip, short and bright."""
    coins = decay(r.foley(coin, 0.16), 0.06)
    clink = highpass(r.foley(chip, 0.12), 1500)
    return finish(mix(0.2, (coins, 0, 0.8), (clink, 0, 0.7)), reverb=0.05, peak=0.6)


def cue_shard_token(r):
    return Sprite(0.22, [
        shard_token_take(r, "handleCoins2", "chip-lay-1"),
        shard_token_take(r, "handleCoins", "chips-collide-3"),
        shard_token_take(r, "handleCoins2", "chip-lay-2"),
    ])


def cue_shards(r):
    coins = r.foley("chips-handle-1", 0.5)
    body = r.play([(0, 0, B5, 90, 0.3), (0.05, 0, E5 + 12, 92, 0.3), (0.1, 0, Gs5 + 12, 96, 0.4)], {0: CELESTA}, 0.8)
    return finish(mix(0.8, (coins, 0, 0.55), (body, 0, 1.0)), reverb=0.14)


# ------------------------------------------------------------------ shop


def shop_in_take(r, paper, place):
    """A shop item dealt onto the counter: paper sliding out, a card set
    down, a quiet harp pluck the page lifts per item."""
    slide = highpass(r.foley(paper, 0.22), 800)
    snap = r.foley(place, 0.18, onset=SNAP)
    pluck = r.play([(0, 0, B4, 64, 0.3), (0, 0, E5, 52, 0.3)], {0: HARP}, 0.4)
    return finish(mix(0.45, (slide, 0, 0.5), (snap, 0.07, 0.9), (pluck, 0.07, 0.4)), reverb=0.1, peak=0.66)


def cue_shop_in(r):
    return Sprite(0.45, [
        shop_in_take(r, "cards-pack-take-out-1", "card-place-3"),
        shop_in_take(r, "cards-pack-take-out-2", "card-place-4"),
    ])


def cue_reroll(r):
    """A riffle shuffle cut short, chips handled, two wood ticks and a quick
    harp run up."""
    riffle = r.foley("card-shuffle", 0.55)
    riffle = swell(riffle, 0.005, 0.35, 0.2)
    chips = r.foley("chips-handle-3", 0.22)
    body = r.play(
        [(0, 9, HI_WOOD, 76, 0.05), (0.06, 9, HI_WOOD, 92, 0.05)] + gliss(0.3, [B4, E5, Gs5, B5], 0.035, 0, 64, 0.35),
        {0: HARP},
        0.85,
    )
    return finish(mix(0.85, (riffle, 0, 0.75), (chips, 0, 0.4), (body, 0.0, 0.7)), reverb=0.1, peak=0.7)


def cue_buy(r):
    """Coins and a glass clink paid out, then the charm set down with a
    book-flat thunk and a two-note marimba up."""
    coins = r.foley("handleCoins2", 0.3)
    glass = highpass(r.foley("impactGlass_light_001", 0.2), 1500)
    thunk = lowpass(r.foley("bookPlace1", 0.25), 4000)
    wood = lowpass(r.foley("impactWood_light_003", 0.15), 900)
    body = r.play([(0, 0, B4, 100, 0.2), (0.16, 0, E5, 110, 0.35), (0.16, 1, E5 + 12, 50, 0.3)], {0: MARIMBA, 1: GLOCKENSPIEL}, 0.75)
    return finish(
        mix(0.8, (coins, 0, 0.6), (glass, 0.0, 0.35), (thunk, 0.16, 0.85), (wood, 0.16, 0.4), (body, 0.0, 0.8)),
        reverb=0.12, peak=0.72,
    )


def cue_sell(r):
    """The buy reversed: the charm lifted off with a slide, coins poured back,
    the marimba two notes down."""
    lift = r.foley("card-slide-2", 0.2)
    coins = r.foley("handleCoins", 0.5)
    chips = r.foley("chips-stack-1", 0.15)
    body = r.play([(0, 0, E5, 100, 0.2), (0.14, 0, B4, 104, 0.35), (0.14, 1, B5, 44, 0.3)], {0: MARIMBA, 1: GLOCKENSPIEL}, 0.75)
    return finish(mix(0.8, (lift, 0, 0.55), (coins, 0.1, 0.55), (chips, 0.14, 0.35), (body, 0.0, 0.8)), reverb=0.12, peak=0.7)


def charm_move_take(r, slide):
    swish = r.foley(slide, 0.16)
    place = lowpass(r.foley("bookPlace3", 0.15), 3000)
    return finish(mix(0.3, (swish, 0, 0.55), (place, 0.08, 0.6)), reverb=0.05, peak=0.6)


def cue_charm_move(r):
    return Sprite(0.3, [charm_move_take(r, "card-slide-4"), charm_move_take(r, "card-slide-8")])


def cue_refuse(r):
    """Not allowed: a dull wood knock doubled a fourth down, muffled."""
    knock = lowpass(r.foley("impactWood_medium_003", 0.22), 1400)
    low = pitch(knock, -4.75)
    body = r.play([(0, 0, E2 + 12, 60, 0.1)], {0: PIZZICATO}, 0.3)
    return finish(mix(0.4, (knock, 0, 1.0), (low, 0.06, 0.75), (body, 0, 0.3)), reverb=0.04, peak=0.64)


def ui_tap_take(r, place, wood):
    tap = decay(r.foley(place, 0.08, onset=SNAP), 0.03)
    block = decay(r.play([(0, 9, wood, 44, 0.03)], {}, 0.08), 0.03)
    return finish(mix(0.1, (tap, 0, 0.6), (block, 0, 0.5)), reverb=0.0, peak=0.55, trim=False)


def cue_ui_tap(r):
    return Sprite(0.14, [ui_tap_take(r, "card-place-1", HI_WOOD), ui_tap_take(r, "card-place-2", LO_WOOD)])


CUES = {
    "pack-open": cue_pack_open,
    "deal": cue_deal,
    "flip": cue_flip,
    "hover": cue_hover,
    "step-notes": chain_sprite(step_notes_take, 0.42),
    "step-combo": chain_sprite(step_combo_take, 0.5),
    "step-multiplier": chain_sprite(step_multiplier_take, 0.6),
    "step-again": chain_sprite(step_again_take, 0.5),
    "charm-fire": chain_sprite(charm_fire_take, 0.5),
    "step-miss": cue_step_miss,
    "finish": cue_finish,
    "count-tick": cue_count_tick,
    "slam": cue_slam,
    "slam-heavy": cue_slam_heavy,
    "fire-ignite": cue_fire_ignite,
    "fire-loop": cue_fire_loop,
    "tally-line": cue_tally_line,
    "tally-total": cue_tally_total,
    "clear-song": cue_clear_song,
    "clear-stage": cue_clear_stage,
    "run-cleared": cue_run_cleared,
    "run-failed": cue_run_failed,
    "shards": cue_shards,
    "shard-token": cue_shard_token,
    "shop-in": cue_shop_in,
    "reroll": cue_reroll,
    "buy": cue_buy,
    "sell": cue_sell,
    "charm-move": cue_charm_move,
    "refuse": cue_refuse,
    "ui-tap": cue_ui_tap,
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--soundfont", required=True)
    parser.add_argument("--kenney", required=True)
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "..", "public", "audio", "packs", "run"))
    parser.add_argument("--only", default="", help="comma-separated cue names")
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    only = {name for name in args.only.split(",") if name}
    with tempfile.TemporaryDirectory() as scratch:
        renderer = Renderer(args.soundfont, args.kenney, scratch)
        # Writes only the cues in CUES; wysi.mp3 (the owner's 727 clip) lives in
        # the same folder and is never touched here.
        for name, build in CUES.items():
            if only and name not in only:
                continue
            built = build(renderer)
            sprite = isinstance(built, Sprite)
            audio = np.asarray(built.render() if sprite else built, dtype=np.float32)
            wav = os.path.join(scratch, f"{name}.wav")
            wavfile.write(wav, SR, audio.T)
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-i", wav, "-c:a", "libmp3lame", "-b:a", "96k", os.path.join(args.out, f"{name}.mp3")],
                check=True,
            )
            shape = f"{len(built.takes)} x {built.slot:.2f}s" if sprite else f"{audio.shape[1] / SR:.2f}s"
            print(f"{name}: {shape}")


if __name__ == "__main__":
    main()
