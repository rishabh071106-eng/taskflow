#!/bin/bash
# Downloads pre-rendered audio assets from GitHub Releases.
# Runs as npm postinstall so Railway builds include the MP3s
# without bloating the git repo.

set -e

AUDIO_DIR="audio-static"
MARKER="$AUDIO_DIR/.fetched"
URL="https://github.com/rishabh071106-eng/taskflow/releases/download/audio-v1/audio-static.tar.gz"

# Skip if already fetched (local dev or cached Railway layer)
if [ -f "$MARKER" ]; then
  echo "[fetch-audio] audio-static/ already present, skipping download."
  exit 0
fi

# Skip if running locally and directory already has MP3s
if [ -d "$AUDIO_DIR" ] && ls "$AUDIO_DIR"/*.mp3 1>/dev/null 2>&1; then
  echo "[fetch-audio] audio-static/ has MP3s locally, skipping download."
  touch "$MARKER"
  exit 0
fi

echo "[fetch-audio] Downloading audio assets from GitHub Release..."
curl -fSL --retry 3 --retry-delay 5 -o /tmp/audio-static.tar.gz "$URL"

echo "[fetch-audio] Extracting..."
tar xzf /tmp/audio-static.tar.gz
rm -f /tmp/audio-static.tar.gz

touch "$MARKER"
COUNT=$(ls -1 "$AUDIO_DIR"/*.mp3 2>/dev/null | wc -l | tr -d ' ')
echo "[fetch-audio] Done. $COUNT MP3 files in $AUDIO_DIR/"
