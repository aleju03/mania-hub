# Companion models

The fumo scans are by Renafox (Sketchfab: kryik1023), licensed under
Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).
Changed here: textures re-encoded as WebP; nothing else.

| File | Source |
| --- | --- |
| fumo-reimu-v2.glb | https://sketchfab.com/3d-models/ff926e77d0564c028bde86fd32a487c1 |
| fumo-cirno.glb | https://sketchfab.com/3d-models/efd2a7f4dbf048c1a18438db7f86c4b9 |
| fumo-flandre.glb | https://sketchfab.com/3d-models/bef0ada62b64410ba523923cf6ac56ce |
| fumo-mokou.glb | https://sketchfab.com/3d-models/f58946a7b7304ef099c0275b1ac3ef18 |
| fumo-youmu.glb | https://sketchfab.com/3d-models/0031ed6284ac4310952095302aad77c2 |
| fumo-yuyuko.glb | https://sketchfab.com/3d-models/6d5d0483009942fb916eedc60ea383a4 |
| fumo-sakuya-inu.glb | https://sketchfab.com/3d-models/7a573802931f485db8118a9d64f26362 |

These are by other Sketchfab artists, also under Creative Commons Attribution 4.0.
Changed here: extra vertex attributes dropped, geometry simplified (fumo-satori
decimated in Blender, the others with meshoptimizer), quantized, and textures
re-encoded as WebP at most 1024 px.

| File | Author | Source |
| --- | --- | --- |
| fumo-satori.glb | DAsh9986 | https://sketchfab.com/3d-models/19bb1a2fad344a639f18f57449cae11d |
| fumo-koishi.glb | 203Null | https://sketchfab.com/3d-models/37a56b489b5c4440bbabb7b7777036f6 |
| fumo-marisa.glb | 203Null | https://sketchfab.com/3d-models/7dea820bf4884ecc8f2c31a085b07428 |
| plush-miku.glb | certified birdbrain | https://sketchfab.com/3d-models/207990ca9c44482b8ff34140d8db3119 |
| plush-miku-xmas.glb | mannymanny | https://sketchfab.com/3d-models/96ec3b0993ba4f97ad961438e1872527 |
| plush-teto.glb | certified birdbrain | https://sketchfab.com/3d-models/207990ca9c44482b8ff34140d8db3119 |
| plush-black-cat.glb | dro | https://sketchfab.com/3d-models/0a81d050ac2c4f2c9adce8b640af1eeb |
| maneki-neko.glb | Rice & Soy Sauce | https://sketchfab.com/3d-models/50b5d360717c442c971b3db0576606c4 |
| cat-maxwell.glb | Zhuier | https://sketchfab.com/3d-models/4175776146ba4550a8dd643363b7b0aa |

plush-miku.glb is remodelled here from the Chubby Teto plush above: its texture recoloured to Miku's teal (dark charcoal on the boots), the drill twintails, hair curl and a stray tail piece removed, and long twintails and hair ties modelled in Blender (~/Projects/foundry/designs/miku-plush/build.py).

blob-pink.glb is the site's own model, built by local-notes/companions/blob/make_blob.py.
leek.glb is the site's own model, made in Blender (~/Projects/3d-modelling/leek); its cel shading is drawn by src/lib/companion-toon.ts from the materials' toon extras.
fairy-white.glb, fairy-red.glb and fairy-blue.glb are the site's own models, made in Blender (~/Projects/3d-modelling/fairies/build_navi.py); src/lib/companion-toon.ts draws their light and wings from the materials' extras (extras.light, extras.wing) and beats the wings and hovers the fairy from the nodes' extras (extras.flap, extras.hover).
taiko-don.glb and taiko-ka.glb are the site's own models, made in Blender (~/Projects/3d-modelling/donchan/build_donchan.py); the characters, Don-chan and Ka-chan, are Bandai Namco's (Taiko no Tatsujin). src/lib/companion-toon.ts draws their flat cel colour from the materials' toon extras; they sit still (no motion extras).
makiba.glb is the site's own model, made in Blender (~/Projects/3d-modelling/makiba/build_makiba.py) from a 2D drawing of the anime cat Makiba; the character is not the site's. src/lib/companion-toon.ts draws its cel shading from the materials' toon extras; it sits still (no motion extras). makiba-chubby.glb is the same build with `--chubby`, a warp that widens the body and head before the outlines are made.
