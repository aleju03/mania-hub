# Pack audio

Everything else in the pack flow is synthesized at runtime (`src/components/packs/packSfx.ts`,
no assets). This folder is the exception: the Eternal card is the one-time reward for
completing the whole collection, and a WebAudio approximation of a cinematic hit read as
artificial next to the moment it marks.

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

Playback is best effort, like every other sound on the site: `playEternalFanfare` prefers
this buffer and falls back to the synthesized cue if the file is missing, blocked or fails
to decode, so deleting it degrades the moment instead of breaking it. `prefetchEternalFanfare`
is fired the moment a dealt hand is known to contain the card, which is what guarantees it
is decoded before the reveal reaches it.
