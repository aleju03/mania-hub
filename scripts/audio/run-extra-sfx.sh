#!/bin/sh
# Renders two pack-run cues the Python set doesn't (public/audio/packs/run/):
#   played.mp3   a map card fires with a player who played it: a quick
#                clap-clap over a soft vibraphone note, a crowd that knows
#                the song
#   interest.mp3 interest on a clear: a tambourine tap landing on a low
#                woodblock, a coin dropped in a wooden box
# Source: CC0 recordings from VCSL (github.com/sgossner/VCSL). ffmpeg only,
# no tone made in code. Bump RUN_SAMPLES_VERSION in
# src/components/packs/packSfx.ts after.
#   sh scripts/audio/run-extra-sfx.sh <VCSL dir> [out dir]
set -e
VCSL=${1:?VCSL directory}
OUT=${2:-public/audio/packs/run}
IDIO="$VCSL/Idiophones/Struck Idiophones"
MEMB="$VCSL/Membranophones/Struck Membranophones"
# Finish: mono 44.1k, a short room, a fixed gain (dB) into a limiter so each
# lands in the set's -12 to -18 LUFS (loudnorm can't lift clips this short),
# MP3 128k.
finish() {
  ffmpeg -hide_banner -loglevel error -y -i "$1" \
    -af "aecho=0.8:0.5:38|71:0.22|0.12,volume=$3dB,alimiter=limit=0.6:attack=2:release=40:level=0,aresample=44100" \
    -ac 1 -c:a libmp3lame -b:a 128k "$2"
}
TMP=$(mktemp -d)

# played: two claps 110 ms apart (two takes, the second a hair higher), the
# second landing with a soft vibraphone E5 that rings out briefly.
ffmpeg -hide_banner -loglevel error -y \
  -i "$IDIO/Claps/Clap_rr2.wav" -i "$IDIO/Claps/Clap_rr4.wav" -i "$IDIO/Vibraphone/Soft Mallets/Vibes_soft_E5_v2_rr1_Main.wav" \
  -filter_complex "[0]atrim=0:0.18,afade=t=out:st=0.08:d=0.1,volume=0.9[a];\
[1]atrim=0:0.22,asetrate=44100*1.05,aresample=44100,afade=t=out:st=0.1:d=0.12,adelay=110|110[b];\
[2]atrim=0:0.7,afade=t=out:st=0.3:d=0.4,adelay=110|110,volume=0.7[c];\
[a][b][c]amix=inputs=3:normalize=0,highpass=f=160" "$TMP/played.wav"
finish "$TMP/played.wav" "$OUT/played.mp3" 10

# interest: a tambourine tap (its jingles a small coin) landing on a low
# woodblock knock, like something dropped in a wooden box, then a lighter
# bounce of the jingles.
ffmpeg -hide_banner -loglevel error -y \
  -i "$IDIO/Tambourine 1/Tamb1_Hit_v2_rr1_Mid.wav" -i "$IDIO/Woodblock/wood_click_f_rr1.wav" -i "$IDIO/Tambourine 1/Tamb1_Hit_v2_rr1_Mid.wav" \
  -filter_complex "[0]atrim=0:0.35,asetrate=44100*1.12,aresample=44100,highpass=f=1400,afade=t=out:st=0.15:d=0.2[a];\
[1]atrim=0:0.3,asetrate=44100*0.72,aresample=44100,afade=t=out:st=0.1:d=0.2,volume=0.7[b];\
[2]atrim=0:0.25,asetrate=44100*1.22,aresample=44100,highpass=f=2000,afade=t=out:st=0.08:d=0.17,adelay=120|120,volume=0.45[c];\
[a][b][c]amix=inputs=3:normalize=0" "$TMP/interest.wav"
finish "$TMP/interest.wav" "$OUT/interest.mp3" 16

rm -rf "$TMP"
