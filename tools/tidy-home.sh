#!/usr/bin/env bash
# tidy-home.sh — Sort loose files in ~/Downloads, ~/Desktop, ~/Documents
# into category folders by file type (macOS).
#
# Behaviour:
#   • Only moves LOOSE files at the top level of each target folder.
#   • Leaves your existing subfolders untouched (so it won't damage
#     organised Documents folders, projects, etc).
#   • Idempotent — safe to re-run; already-categorised files stay put
#     because the script also skips its own category folders.
#   • Resolves name conflicts by appending " (n)" so nothing is overwritten.
#   • Skips dotfiles (.DS_Store, .localized, .Trash, etc).
#
# Usage:
#   bash tidy-home.sh             # actually move files
#   bash tidy-home.sh --dry-run   # preview only, nothing moves
#
# Categories created: PDFs · Docs · Images · Audio · Video · Archives ·
#                     Installers · Code · Other

set -euo pipefail

DRY_RUN=0
case "${1:-}" in
  --dry-run|-n) DRY_RUN=1 ;;
esac

# Folders to tidy. Edit this list to taste.
TARGETS=(
  "$HOME/Downloads"
  "$HOME/Desktop"
  "$HOME/Documents"
)

# Category folders the script may create.  Anything that already lives in
# one of these folders is left alone (idempotent).
CATEGORY_NAMES=(PDFs Docs Images Audio Video Archives Installers Code Other)

ext_to_category() {
  local ext="$1"
  case "$ext" in
    pdf) echo "PDFs" ;;
    doc|docx|odt|rtf|txt|md|markdown|pages|ppt|pptx|key|keynote|\
xls|xlsx|csv|numbers|epub|mobi)
      echo "Docs" ;;
    jpg|jpeg|png|gif|heic|heif|webp|bmp|tif|tiff|svg|raw|cr2|nef|psd|ai)
      echo "Images" ;;
    mp3|wav|m4a|aac|flac|ogg|aiff|aif|opus|wma)
      echo "Audio" ;;
    mp4|mov|mkv|avi|webm|m4v|wmv|flv|mpg|mpeg)
      echo "Video" ;;
    zip|tar|gz|tgz|rar|7z|bz2|xz|tbz)
      echo "Archives" ;;
    dmg|pkg|iso|app)
      echo "Installers" ;;
    py|js|ts|tsx|jsx|html|htm|css|scss|sass|less|json|yml|yaml|toml|\
sh|zsh|bash|rb|go|java|kt|swift|c|cpp|h|hpp|rs|php|r|sql|lua|pl|m|mm|\
xml|ipynb|env|gitignore|dockerfile)
      echo "Code" ;;
    *) echo "Other" ;;
  esac
}

is_category_folder() {
  local name="$1"
  for cat in "${CATEGORY_NAMES[@]}"; do
    [[ "$name" == "$cat" ]] && return 0
  done
  return 1
}

unique_destination() {
  # If $1 already exists, append " (n)" before the extension until free.
  local dest="$1"
  if [[ ! -e "$dest" ]]; then
    printf '%s' "$dest"; return
  fi
  local dir base ext stem n=1
  dir=$(dirname "$dest")
  base=$(basename "$dest")
  if [[ "$base" == *.* ]]; then
    ext=".${base##*.}"
    stem="${base%.*}"
  else
    ext=""
    stem="$base"
  fi
  while :; do
    local candidate="$dir/$stem ($n)$ext"
    if [[ ! -e "$candidate" ]]; then
      printf '%s' "$candidate"; return
    fi
    n=$((n + 1))
  done
}

tidy_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    echo "skip: $dir (not a directory)"
    return
  fi
  echo
  echo "==> tidying $dir"
  local moved=0 skipped=0

  shopt -s dotglob nullglob
  for path in "$dir"/*; do
    local name
    name=$(basename "$path")

    # Skip dotfiles.
    [[ "$name" == .* ]] && { skipped=$((skipped+1)); continue; }

    # Skip subdirectories (incl. our own category folders) so existing
    # structure is preserved.
    if [[ -d "$path" ]]; then
      skipped=$((skipped+1))
      continue
    fi

    local ext_lc cat
    if [[ "$name" == *.* ]]; then
      ext_lc=$(printf '%s' "${name##*.}" | tr '[:upper:]' '[:lower:]')
    else
      ext_lc=""
    fi
    cat=$(ext_to_category "$ext_lc")

    local target_dir="$dir/$cat"
    local dest
    dest=$(unique_destination "$target_dir/$name")

    if (( DRY_RUN )); then
      echo "  would move  $name  ->  $cat/"
    else
      mkdir -p "$target_dir"
      mv -- "$path" "$dest"
      echo "  moved       $name  ->  $cat/"
    fi
    moved=$((moved+1))
  done
  shopt -u dotglob nullglob

  echo "  -> $moved file(s) handled, $skipped skipped (dotfiles + subfolders)"
}

main() {
  echo "tidy-home.sh"
  if (( DRY_RUN )); then
    echo "DRY RUN — nothing will move."
  fi
  for t in "${TARGETS[@]}"; do
    tidy_dir "$t"
  done
  echo
  if (( DRY_RUN )); then
    echo "Done (preview). Re-run without --dry-run to actually move."
  else
    echo "Done. Files grouped into: ${CATEGORY_NAMES[*]}"
  fi
}

main "$@"
