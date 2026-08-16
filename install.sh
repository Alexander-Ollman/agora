#!/usr/bin/env bash
#
# Agora installer. Read it before you run it — it is short on purpose.
#
# Does two things:
#   1. symlinks `agora` and `agora-web` into a directory on your PATH
#   2. installs the agent skill for whichever coding agents it finds
#
#   ./install.sh                  # skills for the current project + global bins
#   ./install.sh --global         # skills into your user-level agent config
#   ./install.sh --into ~/work/x  # skills into another project
#   ./install.sh --bin-only       # just the binaries, no skills
#
# Everything it writes is either a symlink or a marker-delimited block, so
# uninstalling is `rm` plus deleting the block. Nothing is written outside the
# paths printed at the end.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${AGORA_BIN_DIR:-$HOME/.local/bin}"
SCOPE="project"
TARGET="$PWD"
DO_SKILLS=1
INSTALLED=()

while [ $# -gt 0 ]; do
  case "$1" in
    --global)   SCOPE="global"; shift ;;
    --into)     SCOPE="project"; TARGET="${2:?--into needs a directory}"; shift 2 ;;
    --bin-only) DO_SKILLS=0; shift ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

# ── prerequisites ──────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "agora: docker is required"; exit 69; }
command -v node   >/dev/null || { echo "agora: node 18+ is required"; exit 69; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { echo "agora: node 18+ required, found $(node -v)"; exit 69; }

# ── binaries ───────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -sf "$HERE/bin/agora"     "$BIN_DIR/agora"
ln -sf "$HERE/bin/agora-web" "$BIN_DIR/agora-web"
INSTALLED+=("$BIN_DIR/agora → $HERE/bin/agora")
INSTALLED+=("$BIN_DIR/agora-web → $HERE/bin/agora-web")

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo; echo "  NOTE  $BIN_DIR is not on your PATH. Add this to your shell profile:";
     echo "          export PATH=\"\$PATH:$BIN_DIR\""; echo ;;
esac

# Append the contract to an AGENTS.md-style file, idempotently. Re-running
# replaces the previous block rather than stacking another copy.
install_agents_md() {
  local dest="$1" snippet="$HERE/skills/codex/AGENTS.snippet.md"
  mkdir -p "$(dirname "$dest")"
  if [ -f "$dest" ] && grep -q 'AGORA:START' "$dest"; then
    node -e '
      const fs=require("fs"), [d,s]=process.argv.slice(1);
      const body=fs.readFileSync(s,"utf8");
      let t=fs.readFileSync(d,"utf8");
      t=t.replace(/<!-- AGORA:START[\s\S]*?<!-- AGORA:END -->\n?/, body);
      fs.writeFileSync(d,t);' "$dest" "$snippet"
  else
    [ -f "$dest" ] && printf '\n' >> "$dest"
    cat "$snippet" >> "$dest"
  fi
  INSTALLED+=("$dest  (AGORA block)")
}

if [ "$DO_SKILLS" = 1 ]; then
  if [ "$SCOPE" = "global" ]; then
    # Only touch a runtime's config if that runtime is actually present —
    # creating ~/.gemini for someone who does not use Gemini is rude.
    if [ -d "$HOME/.claude" ]; then
      mkdir -p "$HOME/.claude/skills/agora"
      cp "$HERE/skills/claude-code/SKILL.md" "$HOME/.claude/skills/agora/SKILL.md"
      INSTALLED+=("$HOME/.claude/skills/agora/SKILL.md")
    fi
    if [ -d "$HOME/.config/opencode" ]; then
      mkdir -p "$HOME/.config/opencode/skill/agora" "$HOME/.config/opencode/command"
      cp "$HERE/skills/opencode/SKILL.md"   "$HOME/.config/opencode/skill/agora/SKILL.md"
      cp "$HERE/skills/opencode/command.md" "$HOME/.config/opencode/command/agora.md"
      INSTALLED+=("$HOME/.config/opencode/skill/agora/SKILL.md")
      INSTALLED+=("$HOME/.config/opencode/command/agora.md")
    fi
    if [ -d "$HOME/.gemini" ]; then
      mkdir -p "$HOME/.gemini/commands"
      cp "$HERE/skills/gemini/agora.toml" "$HOME/.gemini/commands/agora.toml"
      INSTALLED+=("$HOME/.gemini/commands/agora.toml")
    fi
    if [ -d "$HOME/.codex" ]; then
      install_agents_md "$HOME/.codex/AGENTS.md"
    fi
  else
    T="$(cd "$TARGET" && pwd)"
    mkdir -p "$T/.claude/skills/agora" "$T/.opencode/skill/agora" \
             "$T/.opencode/command" "$T/.gemini/commands"
    cp "$HERE/skills/claude-code/SKILL.md" "$T/.claude/skills/agora/SKILL.md"
    cp "$HERE/skills/opencode/SKILL.md"    "$T/.opencode/skill/agora/SKILL.md"
    cp "$HERE/skills/opencode/command.md"  "$T/.opencode/command/agora.md"
    cp "$HERE/skills/gemini/agora.toml"    "$T/.gemini/commands/agora.toml"
    INSTALLED+=("$T/.claude/skills/agora/SKILL.md")
    INSTALLED+=("$T/.opencode/skill/agora/SKILL.md")
    INSTALLED+=("$T/.opencode/command/agora.md")
    INSTALLED+=("$T/.gemini/commands/agora.toml")
    install_agents_md "$T/AGENTS.md"     # Codex, and anything else reading AGENTS.md
  fi
fi

echo
echo "Agora installed."
for i in "${INSTALLED[@]}"; do echo "  $i"; done
cat <<EOF

Next:
  cd $HERE && docker compose up -d
  agora doctor
  agora web start                 # dashboard → http://localhost:7788

Point an agent session at AGENTS.md, or invoke the skill directly:
  Claude Code   /agora
  OpenCode      /agora
  Gemini CLI    /agora
  Codex         reads AGENTS.md automatically
EOF
