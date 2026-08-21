# Spanish translation style guide (mania-tracker.com)

Voice: a native Latin American osu!mania player writing clear, neutral Spanish. The picker uses Spain's flag for recognizability, but the copy should avoid Spain-only vocabulary and read naturally across Latin America.

## Voice and terminology

- Use informal singular `tú` where the English addresses the reader. Prefer concise UI copy and natural rewrites over word-for-word translation.
- Keep `osu!`, `osu!mania`, usernames, song/map titles, skin names, mod acronyms, key modes (`4K`, `7K`), grades (`SS`, `S`, `A`), `pp`, `SR`, `FC`, `LN`, `DT`, `HT`, `MR`, and dan names unchanged.
- Prefer terms Latin American osu!mania players will recognize. When the community normally uses the English term (`beatmap`, `mapper`, `skin`, `replay`, `mods`, `stream`, `jack`, `chordjack`), keep it rather than inventing a formal translation.
- Translate ordinary UI concepts consistently: `settings` -> `ajustes`, `country/region` -> `país/región`, `goal` -> `objetivo`, `rankings` -> `rankings`, `accuracy` -> `precisión`, `collection` -> `colección`. Tracking terminology uses the community verb: `tracked` -> `trackeado` (never `rastreado`).
- Keep feature names consistent across navigation, headings, empty states, and explanations. Establish a glossary entry before choosing different translations for `top plays`, `snipes`, `tracker`, `farm`, `packs`, or arcade-game terminology.

## Hard rules

1. Preserve ICU placeholders and markup exactly: `{0}`, `{name}`, `{count, plural, ...}`, `<0></0>`, and `<1/>`. Every placeholder and tag must appear exactly once; reordering is allowed.
2. Spanish plurals need both `one` and `other` branches whenever the source message has them. Use `#` for the formatted count inside plural branches.
3. Use Spanish punctuation, including opening `¿` and `¡`, and write natural sentence capitalization rather than copying English title case.
4. Do not translate user-generated content or identifiers.
5. Keep compact layout copy compact. Check buttons, tabs, mobile navigation, cards, tooltips, and select options for overflow after translating.
6. The catalog key is `es`; dates, numbers, and generated country names use neutral Latin American locale data (`es-419`).

## Workflow

1. `node scripts/i18n-es/dump-untranslated.mjs` writes JSON chunks to `scripts/i18n-es/es-chunks/`.
2. Translate each chunk into `{ "<msgid>": "<Spanish>" }` JSON files in `scripts/i18n-es/es-out/`.
3. `node scripts/i18n-es/merge-es.mjs scripts/i18n-es/es-out/*.json` merges only currently empty translations.
4. Run `npm run i18n:extract` to normalize the PO while preserving translations, then `npm run i18n:compile`.
5. Run the frontend tests and type-check, then review the UI at desktop and mobile widths.
