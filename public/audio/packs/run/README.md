# Pack run audio

Every beat of the pack run (`runSound` in `src/components/packs/run/runSound.ts`, played through
`playRunCue` in `src/components/packs/packSfx.ts`), rendered by `scripts/audio/pack-run-sfx.py`:
recorded foley layered with sampled acoustic instruments, sequenced as MIDI and played through
FluidSynth, then mixed with numpy (trims, filters, envelopes, light saturation) and finished with
pedalboard's reverb, compression and limiting. No tone is generated in code. To change one, edit
its `cue_*` function, re-run the script (setup in its docstring) and bump `RUN_SAMPLES_VERSION` in
`packSfx.ts`.

Sprites are one file holding fixed-length slots end to end, each slot a different take of the same
cue; the page plays one slot. The five scoring-step sprites hold four takes each of a foley hit with
a short damped note under it, all at one base pitch; the page raises the whole hit by playback rate
as the chain grows (0.9 + 0.016 per step, capped at 1.4), so the foley climbs with the note. Each
step's level is set in the render (`STEP_PEAK`) and the page plays them at one gain. Slot lengths
are mirrored in `RUN_CUES` in `packSfx.ts`.
`fire-loop.mp3` holds 6 s of flame padded on each side with 0.1 s of its own wrap; the page loops it
between those points.

## Sources

All free to use in anything. SHA-256 values are of the files the current set was rendered from.

- **GeneralUser GS v2.0.3** SoundFont by S. Christian Collins
  ([github.com/mrbumpy409/GeneralUser-GS](https://github.com/mrbumpy409/GeneralUser-GS)). The repo
  has no tags or releases; v2.0.3 is commit `97049183643d5fc5a9322a69c5b09efb667c6c3a` ("Update
  SoundFont to v2.0.3 and documentation to r5"), file
  [GeneralUser-GS.sf2](https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/97049183643d5fc5a9322a69c5b09efb667c6c3a/GeneralUser-GS.sf2),
  sha256 `9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe`. Its license allows any
  use of music made with it, private or commercial.
- **Kenney** ([kenney.nl](https://kenney.nl)), CC0:
  - Casino Audio, [kenney_casino-audio.zip](https://kenney.nl/media/pages/assets/casino-audio/2472606a04-1721639069/kenney_casino-audio.zip),
    sha256 `f36250766ac5bc378c13708ddf12a23a8e54a3251f8d482c7536e51b5dbafa18`
  - Impact Sounds, [kenney_impact-sounds.zip](https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip),
    sha256 `029d734af1582474edf3a694d1b0cebc97c1c152f2f39fa34d4c2bafc5de77f8`
  - RPG Audio, [kenney_rpg-audio.zip](https://kenney.nl/media/pages/assets/rpg-audio/8e99002d76-1677590336/kenney_rpg-audio.zip),
    sha256 `6dbeaf8544da958d8f2adcb4a4a4b76c1ade34a05f8ab9edccd327da7375f38b`
- **OpenGameArt**, CC0:
  - "Fireplace Sound Loop" by PagDev ([page](https://opengameart.org/content/fireplace-sound-loop)),
    [fire.wav](https://opengameart.org/sites/default/files/fire.wav),
    sha256 `85ca0cc60d0c037fff8b185e31ad1fcdbda6ce45eee17c3ee1318d1b8f59e330`
  - "Fire Staff Sound Effects" by LEGIT Audio ([page](https://opengameart.org/content/fire-staff-sound-effects)),
    [legit_audio_fire_staff_-_free_0.zip](https://opengameart.org/sites/default/files/legit_audio_fire_staff_-_free_0.zip),
    sha256 `8c0668fdde03de52b9b201e672244992ae739438937d4bef6908d1618a86b020` (takes 8 and 25)

Unzip everything into one folder and pass it as `--kenney`.

## Files

| File | Beat | Made of |
| --- | --- | --- |
| `pack-open.mp3` | pack opened on the table | foil tear, cards sliding out, a soft thump, a harp and celesta lift |
| `deal.mp3` (3 takes) | a card dealt | card slide, card snap, a little wood under the snap |
| `flip.mp3` (3 takes) | a card turned face up | page flick and card snap, 120 ms, a celesta tink about 10 dB under |
| `hover.mp3` (3 takes) | pointer over a card | a low-passed card or cloth rub |
| `step-notes.mp3` (4 takes) | notes step | card flick, chip clink, chip rattle, a marimba tick far under them |
| `step-combo.mp3` (4 takes) | combo step | chip stack slapped with a wood knock and wood block, a second clink, a damped xylophone fifth under them |
| `step-multiplier.mp3` (4 takes) | multiplier step | fist on wood doubled a fourth down, book slap, plank, punch, chips grabbed, a soft timpani and damped marimba octave under them |
| `step-again.mp3` (4 takes) | a card scoring again | the card slapped twice, chip clink and rattle, a damped marimba note struck twice |
| `charm-fire.mp3` (4 takes) | a charm firing | card shove, glass tap, chip laid down, chip rattle, damped vibraphone and celesta |
| `step-miss.mp3` | a card a mod zeroed | dull wood knock doubled a fourth down, two falling pizzicato notes |
| `finish.mp3` | the chain done | card shove, punch, E major marimba chord, glockenspiel, vibraphone, soft crash |
| `count-tick.mp3` (4 takes) | score counting up | a chip clink cut to 40 ms and gritted, over a wood block or claves |
| `slam.mp3` | the total landing | fist on wood doubled a fourth down, book slap, plank, wood knock, heavy punch, low marimba chord, timpani, kick, chip shower, short crash |
| `slam-heavy.mp3` | weight under the slam, 35% to full by share of the target | a deeper soft impact, plank, fist, taiko, timpani, low string stab, crash |
| `fire-ignite.mp3` | score passes the target | a recorded fire burst, timpani, a riffle an octave down, recorded flame roar swelling, fireplace crackle |
| `fire-loop.mp3` | while the score stays over target | the recorded flame roar, darker, with fireplace crackle, levelled so every 100 ms sits within 3 dB of the median, looped |
| `tally-line.mp3` | a tally line | low wood click, chip, marimba and celesta fifth; pitched up per line |
| `tally-total.mp3` | the tally total | coins, chips, book thunk, E major marimba chord, glockenspiel, timpani |
| `clear-song.mp3` | a song cleared | harp glissando into marimba and celesta, chips at the landing |
| `clear-stage.mp3` | a stage's final song cleared | the last bar of the table music, "Cool Vibes" by Kevin MacLeod (CC BY 4.0, credited with the music), into its final hit; cut by local-notes/overjoy-sfx/cues/stage_cleared.py |
| `run-cleared.mp3` | all stages cleared | timpani swell, harp, vibraphone melody over strings and choir, crash, glockenspiel |
| `run-failed.mp3` | a run failed | a dull wood knock at half pitch doubled a fourth further down, a riffle an octave down, a falling vibraphone line, low strings and timpani under them |
| `shards.mp3` | shards paid | chips in the hand under a rising celesta arpeggio |
| `shop-in.mp3` (2 takes) | a shop item dealt | a card pushed onto the counter: Kenney Casino Audio "card-shove-2" and "card-shove-4" (CC0), cut by local-notes/overjoy-sfx/cues/shop_in.py rather than the renderer |
| `reroll.mp3` | shop rerolled | riffle shuffle, chips, two wood ticks, harp run up |
| `buy.mp3` | an item bought | coins, glass clink, book thunk, wood, marimba two notes up |
| `sell.mp3` | a charm sold | card slide off, coins poured, chips, marimba two notes down |
| `charm-move.mp3` (2 takes) | a charm moved | card slide, soft book thunk |
| `refuse.mp3` | an action refused | dull wood knock doubled a fourth down, muffled pizzicato |
| `ui-tap.mp3` (2 takes) | a menu tap | card snap and wood block, dry |
| `wysi.mp3` | 727 | clip supplied by the owner |

## played, interest

Rendered by `scripts/audio/run-extra-sfx.sh` with ffmpeg alone (trims, fades, reversing,
pitch by resampling, delays, filters, a short room, a fixed gain into a limiter), from CC0
instrument recordings:

- **played** (a map card fires with a player who played it): two hand claps 110 ms apart over
  a soft-mallet vibraphone E5. VCSL `Claps/Clap_rr2`, `Clap_rr4`,
  `Vibraphone/Soft Mallets/Vibes_soft_E5_v2_rr1_Main`.
- **interest** (shards earned on what you hold): a tambourine tap landing on a woodblock knock
  pitched down, like a coin dropped in a wooden box, with a lighter bounce of the jingles after.
  VCSL `Tambourine 1/Tamb1_Hit_v2_rr1_Mid`, `Woodblock/wood_click_f_rr1`.

Source: [VCSL](https://github.com/sgossner/VCSL), CC0.
