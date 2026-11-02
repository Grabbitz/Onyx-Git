#!/bin/sh
# Onyx-Git installer for the Herdr desktop app.
#
#   ./install.sh            install (never overwrites anything that isn't Onyx-Git's own)
#   ./install.sh --no-deps  skip the third-party panels fetched from their own repos
#
# Copies the layout, its theme and its mods into $HERDR_APP_HOME (default ~/.config/herdr-app),
# fetches the panels it uses from their authors' repos, merges keys.json, then checks every mod.
set -eu

HOME_DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEPS=1; [ "${1:-}" = "--no-deps" ] && DEPS=0

[ -d "$HOME_DIR" ] || { echo "No Herdr home at $HOME_DIR (install Herdr first, or set HERDR_APP_HOME)."; exit 1; }
command -v git >/dev/null || { echo "git is required."; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required (keys.json merge)."; exit 1; }
mkdir -p "$HOME_DIR/layouts" "$HOME_DIR/themes" "$HOME_DIR/mods"

say() { printf '  %s\n' "$*"; }
copy_dir() { # copy_dir <src> <dest-name> <overwrite: yes|no>
  dest="$HOME_DIR/mods/$2"
  if [ -e "$dest" ] && [ "$3" = no ]; then say "keep   mods/$2 (already there)"; return 1; fi
  rm -rf "$dest"; cp -R "$1" "$dest"; say "copy   mods/$2"
}

echo "Onyx-Git → $HOME_DIR"
cp "$SRC/layouts/onyx-git.json" "$SRC/layouts/onyx-git.png" "$HOME_DIR/layouts/"; say "copy   layouts/onyx-git.json"
cp "$SRC/themes/onyx-git.json" "$HOME_DIR/themes/"; say "copy   themes/onyx-git.json"

# Onyx-Git's own mods are updated in place; the bundled herdr-t3 mods are only added when missing.
for m in onyx-tabs onyx-spaces onyx-status onyx-quota; do copy_dir "$SRC/mods/$m" "$m" yes; done
for m in t3-agents t3-chrome t3-focus t3-pane t3-new-menu; do copy_dir "$SRC/mods/$m" "$m" no || true; done

if [ "$DEPS" = 1 ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  fetch() { git clone -q --depth 1 "https://github.com/$1" "$TMP/$(basename "$1")"; }
  echo "Panels from their authors' repos:"
  fetch jankeesvw/herdr-issues && copy_dir "$TMP/herdr-issues/mods/issues" issues no || true
  fetch aBER0724/herdr-git-changes && copy_dir "$TMP/herdr-git-changes/mods/git-changes" git-changes no || true
  fetch GaganSD/coding-agent-toolkit && copy_dir "$TMP/coding-agent-toolkit/herdr-insights/mods/insights" insights no || true
  if fetch o101k/herdr-lazygit && copy_dir "$TMP/herdr-lazygit/mods/lazygit-panel" lazygit-panel no; then
    # lazygit-panel only acts inside its own "lazygit" layout; let it act in onyx-git too.
    sed -i.bak -e 's/shared("layout") === "lazygit"/["lazygit", "onyx-git"].includes(shared("layout"))/' \
      -e 's/shared("layout") !== "lazygit"/!["lazygit", "onyx-git"].includes(shared("layout"))/' \
      "$HOME_DIR/mods/lazygit-panel/main.js" && rm -f "$HOME_DIR/mods/lazygit-panel/main.js.bak"
  fi
  # herdr-github installs as "gh-prs": the name "github" is often taken.
  if fetch mrolafsson/herdr-github && copy_dir "$TMP/herdr-github/app/mods/github" gh-prs no; then
    sed -i.bak 's#mods/github/icons#mods/gh-prs/icons#' "$HOME_DIR/mods/gh-prs/look.js"
    sed -i.bak -e 's#back: "github"#back: "gh-prs"#' -e 's#backTo: { mod: "github"#backTo: { mod: "gh-prs"#' "$HOME_DIR/mods/gh-prs/main.js"
    rm -f "$HOME_DIR/mods/gh-prs/"*.bak
  fi
fi

# keys.json: add the layout's section; never replace a key you already set there.
python3 -I - "$HOME_DIR/keys.json" "$SRC/keys.json" <<'PY'
import json, os, sys
dst, src = sys.argv[1], sys.argv[2]
mine = json.load(open(dst)) if os.path.exists(dst) else {}
for section, keys in json.load(open(src)).items():
    have = mine.setdefault(section, {})
    for k, v in keys.items():
        have.setdefault(k, v)
json.dump(mine, open(dst, "w"), indent=2)
print("  merge  keys.json")
PY

if command -v herdr-app >/dev/null; then
  echo "Checking mods:"
  for m in onyx-tabs onyx-spaces onyx-status onyx-quota t3-agents t3-chrome t3-focus t3-pane t3-new-menu \
           issues git-changes insights lazygit-panel gh-prs; do
    [ -d "$HOME_DIR/mods/$m" ] && { herdr-app check "$HOME_DIR/mods/$m" >/dev/null 2>&1 && say "ok     $m" || say "FAILED $m (herdr-app check $HOME_DIR/mods/$m)"; }
  done
fi

command -v quota-axi >/dev/null || echo "Note: the quota strip needs quota-axi → npm install -g quota-axi"
command -v lazygit >/dev/null || echo "Note: the Lazygit panel needs lazygit → brew install lazygit"
command -v gh >/dev/null || echo "Note: Issues and PRs need the GitHub CLI → brew install gh && gh auth login"
echo "Done. Switch with: herdr-app do layout.switch --name onyx-git"
