#!/usr/bin/env bash
# Naukri Assistant.command — double-clickable launcher for macOS Finder.
#
# Usage: double-click this file in Finder. A Terminal window opens, the
# assistant runs, you log in and click Submit yourself in the browser.
#
# First-time setup: see SETUP.md (need to create .venv and install
# Playwright once before this works).

set -e
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  echo "ERROR: .venv not found in $(pwd)"
  echo
  echo "First-time setup is needed. Open Terminal and run:"
  echo "    cd \"$(pwd)\""
  echo "    python3 -m venv .venv"
  echo "    source .venv/bin/activate"
  echo "    pip install playwright"
  echo "    python -m playwright install chromium"
  echo
  echo "Then double-click this file again."
  echo
  read -n 1 -s -r -p "Press any key to close..."
  exit 1
fi

source .venv/bin/activate

# Activate apply mode by default.  Pass --dry-run as the first argument
# to score-only without filling any forms.
MODE="--apply"
if [[ "${1:-}" == "--dry-run" || "${1:-}" == "-n" ]]; then
  MODE=""
fi

python3 naukri_assistant.py $MODE

echo
echo "================================================================"
echo "  Naukri Assistant finished. Check applications.csv for the log."
echo "================================================================"
read -n 1 -s -r -p "Press any key to close..."
