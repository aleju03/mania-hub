# Pack audio

Everything else in the pack flow is synthesized at runtime (`src/components/packs/packSfx.ts`,
no assets). This folder is the exception: the Eternal card is the one-time reward for
completing the whole collection and the golden card goes to the millionth pack, and a
WebAudio approximation of a cinematic hit read as artificial next to the moments they mark.

## eternal-pull.mp3

The Eternal reveal cue. About 4.4 seconds, matching `ETERNAL_CEREMONY_MS` in
`src/components/packs/EternalBurst.tsx`: near silence, a riser, the impact landing at
**0.95s** (the same instant as the burst's flash), then the body and its decay under the
held card.

Rendered from two **CC0 / public domain** sources on Freesound, layered so the riser leads
into the braam:

| Layer | Source | Author | Freesound ID |
| --- | --- | --- | --- |
| Riser into the hit | "Riser Hit sfx 091" | AudioPapkin | [754160](https://freesound.org/people/AudioPapkin/sounds/754160/) |
| Impact body and tail | "BRAAM-HIT" | vykroft | [431316](https://freesound.org/people/vykroft/sounds/431316/) |

Both are released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
(public domain dedication), so no attribution is required and redistribution inside this
site is unrestricted. The table is provenance for whoever edits this next, not a license
obligation.

Processing: the riser was trimmed so its peak lands at 0.95s, the braam delayed by 250ms to
strike on the same frame, mixed, faded out from 3.95s, loudness-normalized to about -13
LUFS with a -1 dBTP ceiling, and encoded to 128 kbps stereo MP3 (~70 KB). MP3 rather than
OGG so Safari plays it without a second copy.

## milestone-pull.mp3

The millionth-pack reveal cue. 4.6 seconds, matching `MILESTONE_CEREMONY_MS` in
`src/components/packs/MilestoneBurst.tsx`: ticks bunching up under the rolling counter, a
swell, the lock landing at **1.8s** (the frame the counter stops and the flash fires), then
a bell chord ringing out under the falling gold.

Assembled from **CC0** sources, one on OpenGameArt and the rest from Kenney's packs
(Impact Sounds, Interface Sounds, Sci-Fi Sounds), all CC0 1.0:

| Layer | Source | Author | Where |
| --- | --- | --- | --- |
| Counter ticks | Interface Sounds `tick_001/002/004` | Kenney | [kenney.nl](https://kenney.nl/assets/interface-sounds) |
| Sub swell into the lock, and the boom on it | Sci-Fi Sounds `lowFrequency_explosion_000` (reversed, then forward) | Kenney | [kenney.nl](https://kenney.nl/assets/sci-fi-sounds) |
| Crashes on the lock (one reversed into it) | Impact Sounds `impactPlate_heavy_000/001` | Kenney | [kenney.nl](https://kenney.nl/assets/impact-sounds) |
| Debris under the crash | Sci-Fi Sounds `explosionCrunch_000` | Kenney | same |
| Bell strike on the lock | Impact Sounds `impactBell_heavy_003`, pitched to C | Kenney | same |
| Bell chord, the climbing cascade and the high shimmer after it (one ding pitched per note), and reversed as the swell | "4 Metal Dings/Rings" (`ding.1/2/3.ogg`) | StarNinjas | [OpenGameArt](https://opengameart.org/content/4-metal-dingsrings) |

Processing: 30 ticks placed on the same accelerating curve the burst's counter uses, each
a hair higher than the last; the reversed boom, bell and crash ending on 1.8s; the boom,
crashes, debris and bell strike on that frame; the ding pitched to C, E, G and the octave
and staggered over the next 300ms, then a cascade of nine bells climbing two and a half
octaves out of the chord and a high shimmer fading through the gold fall. Mixed in mono, limited, brought to about -13 LUFS like
the Eternal cue, and encoded to 128 kbps stereo MP3 (~75 KB).

## Playback

Playback is best effort, like every other sound on the site: `playEternalFanfare` and
`playMilestoneFanfare` prefer their buffer and fall back to the synthesized cue if the file
is missing, blocked or fails to decode, so deleting one degrades the moment instead of
breaking it. `prefetchEternalFanfare` / `prefetchMilestoneFanfare` fire the moment a dealt
hand is known to contain the card, which is what guarantees it is decoded before the reveal
reaches it.
