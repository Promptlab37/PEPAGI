#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# PEPAGI — Installer (Mac / Linux)
# ═══════════════════════════════════════════════════════════════

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       PEPAGI — Instalace          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ─── Check Node.js ───────────────────────────────────────────

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js není nainstalovaný!${NC}"
    echo ""
    echo "  Nainstaluj Node.js 22+ z https://nodejs.org"
    echo ""
    if [[ "$OSTYPE" == "darwin"* ]]; then
        echo "  Nebo přes Homebrew: brew install node@22"
    fi
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo -e "${YELLOW}⚠ Node.js verze $(node -v) — doporučeno 22+${NC}"
    read -p "  Pokračovat i tak? [y/N]: " yn
    if [[ ! "$yn" =~ ^[Yy]$ ]]; then exit 1; fi
fi

echo -e "${GREEN}✓ Node.js $(node -v) nalezen${NC}"

# ─── Check npm ───────────────────────────────────────────────

if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm není dostupný!${NC}"
    exit 1
fi

echo -e "${GREEN}✓ npm $(npm -v) nalezen${NC}"

# ─── Install dependencies ────────────────────────────────────

echo ""
echo -e "${CYAN}Instaluji závislosti...${NC}"
npm install

echo -e "${GREEN}✓ Závislosti nainstalovány${NC}"

# ─── Register `pepagi` command globally ───────────────────────

chmod +x bin/pepagi

echo ""
echo -e "${CYAN}Registruji příkaz 'pepagi' globálně...${NC}"
if npm link 2>/dev/null; then
    echo -e "${GREEN}✓ Příkaz 'pepagi' je nyní dostupný globálně${NC}"
else
    # Fallback: symlink to ~/.local/bin
    LINK_DIR="$HOME/.local/bin"
    mkdir -p "$LINK_DIR"
    ln -sf "$(pwd)/bin/pepagi" "$LINK_DIR/pepagi"
    echo -e "${GREEN}✓ Příkaz 'pepagi' přidán do $LINK_DIR${NC}"
    echo -e "${YELLOW}  Ujisti se, že ~/.local/bin je v PATH:${NC}"
    echo -e "  ${CYAN}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc${NC}"
fi

# ─── Create data directories ─────────────────────────────────

PEPAGI_DIR="$HOME/.pepagi"
mkdir -p "$PEPAGI_DIR/memory"
mkdir -p "$PEPAGI_DIR/logs"
mkdir -p "$PEPAGI_DIR/causal"
mkdir -p "$PEPAGI_DIR/skills"
mkdir -p "$PEPAGI_DIR/identity"

echo -e "${GREEN}✓ Datové složky vytvořeny: $PEPAGI_DIR${NC}"

# ─── Create .env from example ────────────────────────────────

if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ .env soubor vytvořen${NC}"
fi

# ─── Check Claude CLI (optional but recommended) ─────────────

echo ""
if command -v claude &> /dev/null; then
    echo -e "${GREEN}✓ Claude Code CLI nalezen — OAuth autentizace dostupná${NC}"
    echo -e "${CYAN}  (Nemusíš zadávat API klíč pro Claude)${NC}"
else
    echo -e "${YELLOW}ℹ Claude Code CLI není nainstalovaný${NC}"
    echo "  Bez něj budeš potřebovat Anthropic API klíč."
    echo "  Instalace Claude Code CLI: https://claude.ai/download"
fi

# ─── Run setup wizard ────────────────────────────────────────

echo ""
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo -e "${CYAN}  Spouštím průvodce nastavením...${NC}"
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo ""

npm run setup

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     PEPAGI je připraven! 🎉       ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  Příkazy:"
echo -e "  ${CYAN}npm start${NC}                    — otevřít chat v terminálu"
echo -e "  ${CYAN}npm run daemon${NC}               — spustit daemon v popředí (Telegram/WhatsApp)"
echo ""
echo "  Správa daemona na pozadí:"
echo -e "  ${CYAN}npx tsx src/cli.ts daemon start${NC}      — spustit na pozadí"
echo -e "  ${CYAN}npx tsx src/cli.ts daemon stop${NC}       — zastavit"
echo -e "  ${CYAN}npx tsx src/cli.ts daemon status${NC}     — stav"
echo -e "  ${CYAN}npx tsx src/cli.ts daemon install${NC}    — nainstalovat jako službu (auto-start při přihlášení)"
echo ""
echo "  Po přidání do PATH:"
echo -e "  ${CYAN}pepagi${NC}              — otevřít chat"
echo -e "  ${CYAN}pepagi daemon start${NC} — spustit daemon na pozadí"
echo -e "  ${CYAN}pepagi daemon install${NC}— nainstalovat jako systémovou službu"
echo ""
