#!/bin/bash
# Polar Apollo Installer
# Run this script to install all Polar Apollo components.
#
# What gets installed:
#   1. Antigravity Extension → ~/.antigravity/extensions/polar-apollo-0.1.0/
#   2. CLI Tool              → ~/.local/bin/polar-apollo
#   3. OpenClaw Skill        → ~/.gemini/antigravity/skills/polar-apollo/
#
# Usage: bash install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo ""
echo "🚀 Polar Apollo Installer"
echo "========================="
echo ""

# --- 1. Install Antigravity Extension ---
EXT_DIR="$HOME/.antigravity/extensions/polar-apollo-0.1.0"
echo "📦 [1/3] Installing Antigravity extension..."
mkdir -p "$EXT_DIR"
cp "$SCRIPT_DIR/extension/extension.js" "$EXT_DIR/"
cp "$SCRIPT_DIR/extension/package.json" "$EXT_DIR/"
echo "   ✅ Installed to $EXT_DIR"

# --- 2. Install CLI Tool ---
CLI_DIR="$HOME/.local/bin"
echo "📦 [2/3] Installing CLI tool..."
mkdir -p "$CLI_DIR"
cp "$SCRIPT_DIR/cli/polar-apollo" "$CLI_DIR/"
chmod +x "$CLI_DIR/polar-apollo"
echo "   ✅ Installed to $CLI_DIR/polar-apollo"

# Check PATH
if ! echo "$PATH" | grep -q ".local/bin"; then
  echo ""
  echo "   ⚠️  ~/.local/bin is not in your PATH."
  echo "   Add this to your ~/.zshrc:"
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

# --- 3. Install OpenClaw Skill ---
SKILL_DIR="$HOME/.gemini/antigravity/skills/polar-apollo"
echo "📦 [3/3] Installing OpenClaw skill..."
mkdir -p "$SKILL_DIR"
cp "$SCRIPT_DIR/skill/SKILL.md" "$SKILL_DIR/"
echo "   ✅ Installed to $SKILL_DIR"

# --- Done ---
echo ""
echo "========================="
echo "✅ Polar Apollo installed!"
echo ""
echo "📋 Next steps:"
echo ""
echo "  1. RELOAD ANTIGRAVITY"
echo "     Cmd+Shift+P → Reload Window"
echo "     (Wait ~3 seconds after reload)"
echo ""
echo "  2. GRANT ACCESSIBILITY PERMISSION"
echo "     The first time you use polar-apollo, macOS will ask you"
echo "     to grant Accessibility permissions to Antigravity."
echo "     Go to: System Settings → Privacy & Security → Accessibility"
echo "     → Enable 'Antigravity'"
echo ""
echo "  3. TEST IT"
echo "     polar-apollo \"Hello from Polar Apollo\""
echo ""
