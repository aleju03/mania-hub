# Supporter card art

The doodles a supporter's cards can float (`src/lib/supporter-motif-art.ts`). Drawn for this site
by `scripts/dev/card-doodles.html` (open it in a browser; `window.SPRITES` holds the canvases) in the supporter welcome heart's style: wobbly ink
ribbons over an off-register marker fill. No third-party art.

A redrawn doodle takes the next number in its file name (and `ART_VERSION`), because the service
worker keeps anything under `/images/` until its URL changes.
