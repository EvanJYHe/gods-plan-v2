#!/bin/bash
# Encode recorded frames (/tmp/gp-rec/<shot>/) into the landing page's clips in public/media/.
# The hero is the portfolio card film (gods-plan-v2.mp4, copied from jusin-website-copy/public/videos/films/), not encoded here.
set -e
cd "$(dirname "$0")/.."
mkdir -p public/media
enc() { ffmpeg -nostdin -v error -y -framerate 30 -i "/tmp/gp-rec/$1/%04d.jpg" -vf "$2" -c:v libx264 -preset slow -crf "$3" -maxrate "$5" -bufsize "$6" -pix_fmt yuv420p -movflags +faststart -an "$4"; }
# out-name  shot  poster-time(s)
while read -r out shot at; do
  [ -d "/tmp/gp-rec/$shot" ] || { echo "skip $out (no /tmp/gp-rec/$shot)"; continue; }
  enc "$shot" "scale=1280:720" 25 "public/media/$out.mp4" 1800k 3600k
  ffmpeg -nostdin -v error -y -ss "$at" -i "public/media/$out.mp4" -frames:v 1 -vf scale=1280:720 -q:v 4 "public/media/$out.jpg"
done <<'EOF'
tsunami land-tsunami 2.5
nuke land-nuke 4.5
meteor land-meteor 2.4
city land-city 3
night land-night 3
skyline land-skyline 3
nuke-close land-nuke-close 2.2
tsunami-close beat-tsunami 1.2
EOF
ls -la public/media
