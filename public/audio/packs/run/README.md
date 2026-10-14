# Pack run audio

The pack run's tally cues (`playRun*` in `src/components/packs/packSfx.ts`), rendered by
`scripts/audio/pack-run-sfx.py`: recorded foley layered with sampled acoustic instruments,
sequenced as MIDI and played through FluidSynth, then finished with pedalboard's reverb,
compression and limiting. To change one, edit its `cue_*` function, re-run the script (setup in
its docstring) and bump `RUN_SAMPLES_VERSION` in `packSfx.ts`.

Sources, both free to use in anything:

- **GeneralUser GS 2.0** SoundFont by S. Christian Collins
  ([github.com/mrbumpy409/GeneralUser-GS](https://github.com/mrbumpy409/GeneralUser-GS)). Its
  license allows any use of music made with it, private or commercial.
- **Kenney** Casino Audio, Impact Sounds and Interface Sounds ([kenney.nl](https://kenney.nl)),
  CC0.

| File | Used for | Made of |
| --- | --- | --- |
| `note-1.mp3`, `note-2.mp3` | a note step, alternated | a card flick over a marimba note with a glockenspiel or celesta overtone; pitched up the tally |
| `combo.mp3` | a combo step | a poker-chip stack over a xylophone dyad and a wood block |
| `finish.mp3` | a multiplied combo | a punch and glass impact under timpani, crash, tubular bells and a glockenspiel run |
| `miss.mp3` | a card a mod zeroed | a dull wood knock under three falling pizzicato notes |
| `tick.mp3` | the score meter rolling | claves |
| `slam.mp3` | the total landing | a punch, chip shower and chip handle under timpani, kick, crash and a marimba chord |
| `shards.mp3` | shards paid | chips in the hand under a rising celesta arpeggio |
| `clear-song.mp3` | a song cleared | a harp glissando into a marimba and celesta chord, chips at the landing |
| `clear-stage.mp3` | a stage's final song cleared | harp glissando and a timpani roll into a pizzicato line and a string chord with crash |
| `run-cleared.mp3` | all eight stages cleared | timpani swell, harp, a vibraphone melody over strings, choir and crash, glockenspiel sparkle |
| `run-failed.mp3` | a run failed | a falling vibraphone line over pizzicato, low strings and soft timpani |
