# Mascot action sounds

Drop-in folder for the sounds `/admin/mascot` fires. Nothing here is required:
`src/lib/mascot-sfx.ts` synthesizes a stand-in cue for any file that is missing,
so the actions are audible with this folder empty.

Expected names, one per action, plus the blip his speech bubble types with:

| File | Fires on |
| --- | --- |
| `heal.ogg` | Heal Prayer |
| `pacify.ogg` | Pacify |
| `cheer.ogg` | Cheer |
| `sing.ogg` | Sing |
| `spin.ogg` | Spin |
| `scarf.ogg` | Scarf whip |
| `dark.ogg` | Dark World |
| `appear.ogg` | Appear |
| `vanish.ogg` | Vanish |
| `speech.ogg` | Each character of a speech bubble (keep it very short) |

`.ogg` is only what the manifest happens to name; any format the browser decodes
works, change the extension in `MASCOT_SAMPLE_FILES` to match. Files are fetched
once and decoded when the mascot appears, so a sound added here is live on the
next page load, with no code change.

Whatever you put here is served publicly from `/audio/mascot/`, so it should be
audio you have the right to distribute.
