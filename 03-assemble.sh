#!/usr/bin/env bash
# =============================================================================
# Synapse Mobility export — assemble recorded cine .webm files into clean .mp4
# (and optional GIF + extracted PNG frames).
#
# Usage:
#   1. Drop your recorded loops into  cine-webm/
#   2. ./03-assemble.sh            # webm -> mp4 for everything in cine-webm/
#   3. ./03-assemble.sh --trim     # mp4 trimmed to exactly ONE loop (recommended)
#   4. ./03-assemble.sh --gif      # also make a GIF per loop
#   5. ./03-assemble.sh --frames   # also dump every frame as PNG into frames/<name>/
#   (flags combine, e.g. ./03-assemble.sh --trim --gif)
#
# Requires ffmpeg + ffprobe (you have 8.1.1) and python3 (for --trim).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

IN=cine-webm
OUT=cine-mp4
FRAMES=frames
MAKE_GIF=0
MAKE_FRAMES=0
MAKE_TRIM=0
FROM_DL=0
for arg in "$@"; do
  case "$arg" in
    --trim) MAKE_TRIM=1 ;;
    --gif) MAKE_GIF=1 ;;
    --frames) MAKE_FRAMES=1 ;;
    --from-downloads) FROM_DL=1 ;;
    *) echo "unknown option: $arg"; exit 1 ;;
  esac
done

shopt -s nullglob
mkdir -p "$IN"
# Optionally sweep recorded loops out of ~/Downloads first (no manual moving).
if [ "$FROM_DL" -eq 1 ]; then
  moved=0
  for f in "$HOME"/Downloads/loop_*.webm "$HOME"/Downloads/loop_*.mp4; do
    [ -e "$f" ] || continue; mv "$f" "$IN/" && moved=$((moved+1))
  done
  echo "pulled $moved recording(s) from ~/Downloads into $IN/"
fi

# Accept recordings in either format (the extension now prefers MP4, webm fallback).
files=("$IN"/*.webm "$IN"/*.mp4)
if [ ${#files[@]} -eq 0 ]; then
  echo "No recordings in $IN/. Record some loops, then re-run"
  echo "(tip: ./03-assemble.sh --trim --from-downloads grabs them from ~/Downloads)."
  exit 0
fi

mkdir -p "$OUT" "$FRAMES"
# Pad odd dimensions to even (H.264 needs even width/height); keep "as rendered".
EVEN='pad=ceil(iw/2)*2:ceil(ih/2)*2'

for f in "${files[@]}"; do
  name="$(basename "$f")"; name="${name%.*}"
  echo "==> $name"

  if [ "$MAKE_TRIM" -eq 1 ]; then
    # Detect the loop period and cut exactly one clean cycle.
    python3 "$(dirname "$0")/trim_to_one_loop.py" "$f" "$OUT/$name.mp4"
  else
    # WebM (VP9) -> MP4 (H.264), full clip, high quality, web-friendly.
    ffmpeg -y -loglevel error -i "$f" \
      -vf "$EVEN" -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p \
      -movflags +faststart "$OUT/$name.mp4"
    echo "    mp4  -> $OUT/$name.mp4"
  fi

  if [ "$MAKE_GIF" -eq 1 ]; then
    pal="$(mktemp -t pal).png"
    ffmpeg -y -loglevel error -i "$f" -vf "fps=15,$EVEN,palettegen" "$pal"
    ffmpeg -y -loglevel error -i "$f" -i "$pal" \
      -lavfi "fps=15,$EVEN[x];[x][1:v]paletteuse" "$OUT/$name.gif"
    rm -f "$pal"
    echo "    gif  -> $OUT/$name.gif"
  fi

  if [ "$MAKE_FRAMES" -eq 1 ]; then
    mkdir -p "$FRAMES/$name"
    ffmpeg -y -loglevel error -i "$f" "$FRAMES/$name/%03d.png"
    echo "    frames -> $FRAMES/$name/ ($(ls "$FRAMES/$name" | wc -l | tr -d ' ') png)"
  fi
done

echo "Done."
