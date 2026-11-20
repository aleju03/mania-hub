/* What identifies each 3D companion in public/models/companions, so a
   submitted copy of one is turned away (supporter-companion-upload-server.ts):
   the first 16 hex of the sha256 of its checkGlb geometry key, and the page
   it was downloaded from. Kept in step with the files by
   companion-builtin-models.test.ts, which prints the new lists when a model
   is added or changed. */

export const BUILT_IN_COMPANION_GEOMETRY: ReadonlySet<string> = new Set([
  "06684bfcd0de69ef",
  "163c001547bce305",
  "3bcff0f0c7bd9004",
  "3c0ad63a6a93c800",
  "3f9efd3f23616462",
  "4af65f89ba59cd0e",
  "4eedab6cc5021a61",
  "5dd4563d1b6a1dab",
  "6022232d6c08261e",
  "659da946601f8ac4",
  "735c4854080e8c6b",
  "82a3752b4563b5b1",
  "82f9a1bc1f135b24",
  "9b7fb63db1a23b0c",
  "a2877f52721a89ad",
  "a3ae794e169421b0",
  "a7114ca5434e2315",
  "b35869654ee893f8",
  "c6fb19d2d8a9f3b3",
  "cb963f8318227253",
  "dca4b5e3037790f4",
  "eae7d523982b548a",
  "f9976039cd6aec17",
  "f9c321fd51e3662d",
]);

export const BUILT_IN_COMPANION_SOURCES: ReadonlySet<string> = new Set([
  "https://sketchfab.com/3d-models/black-cat-head-plush-0a81d050ac2c4f2c9adce8b640af1eeb",
  "https://sketchfab.com/3d-models/fatass-teto-plush-207990ca9c44482b8ff34140d8db3119",
  "https://sketchfab.com/3d-models/flandre-scarlet-fumo-free-3d-scan-bef0ada62b64410ba523923cf6ac56ce",
  "https://sketchfab.com/3d-models/hatsune-miku-mega-jumbo-nuigurumi-plush-96ec3b0993ba4f97ad961438e1872527",
  "https://sketchfab.com/3d-models/lucky-cat-maneki-neko-50b5d360717c442c971b3db0576606c4",
  "https://sketchfab.com/3d-models/maxwell-the-cat-with-bones-animation-4175776146ba4550a8dd643363b7b0aa",
  "https://sketchfab.com/3d-models/project-cirno-fumo-3d-scan-efd2a7f4dbf048c1a18438db7f86c4b9",
  "https://sketchfab.com/3d-models/project-inu-sakuya-doll-3d-scan-7a573802931f485db8118a9d64f26362",
  "https://sketchfab.com/3d-models/project-koishi-komeiji-fumo-37a56b489b5c4440bbabb7b7777036f6",
  "https://sketchfab.com/3d-models/project-marisa-kirisame-fumo-7dea820bf4884ecc8f2c31a085b07428",
  "https://sketchfab.com/3d-models/project-mokou-fujiwara-fumo-3d-scan-f58946a7b7304ef099c0275b1ac3ef18",
  "https://sketchfab.com/3d-models/project-v2-reimu-hakurei-fumo-3d-scan-ff926e77d0564c028bde86fd32a487c1",
  "https://sketchfab.com/3d-models/project-v2-youmu-konpaku-fumo-3d-scan-0031ed6284ac4310952095302aad77c2",
  "https://sketchfab.com/3d-models/project-v2-yuyuko-saigyouji-fumo-3d-scan-6d5d0483009942fb916eedc60ea383a4",
]);
