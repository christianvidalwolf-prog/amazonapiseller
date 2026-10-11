#!/usr/bin/env bash
# Crea un worktree listo para trabajar: rama nueva, .env copiados, CSV y .venv enlazados,
# dependencias instaladas y cliente Prisma generado.
#
# Uso:  scripts/new-worktree.sh <nombre> [rama-base] [--no-install]
#   scripts/new-worktree.sh precios                 -> ../amazonapiseller-precios, rama wt/precios desde origin/main
#   scripts/new-worktree.sh fix/bsr origin/main     -> ../amazonapiseller-fix-bsr, rama fix/bsr
# Borrar al terminar: git worktree remove --force ../amazonapiseller-<nombre> && git branch -d <rama>
set -euo pipefail

NAME="${1:?Uso: scripts/new-worktree.sh <nombre> [rama-base] [--no-install]}"
BASE="origin/main"; INSTALL=1
for arg in "${@:2}"; do
  if [ "$arg" = "--no-install" ]; then INSTALL=0; else BASE="$arg"; fi
done

# Carpeta principal del repo (la que tiene los .env y CSV reales), aunque se ejecute desde otro worktree.
MAIN="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
SLUG="${NAME//\//-}"
DIR="$(dirname "$MAIN")/$(basename "$MAIN")-$SLUG"
BRANCH="$NAME"; [[ "$NAME" == */* ]] || BRANCH="wt/$NAME"

[ -e "$DIR" ] && { echo "Ya existe $DIR"; exit 1; }
git -C "$MAIN" fetch -q origin
git -C "$MAIN" worktree add -b "$BRANCH" "$DIR" "$BASE"

# Secretos: copias (cada worktree puede cambiarlos sin afectar al resto).
for f in .env backend/.env frontend/.env.local; do
  [ -f "$MAIN/$f" ] && cp "$MAIN/$f" "$DIR/$f" && echo "copiado  $f"
done

# Datos y entorno Python: enlaces, para que todos los worktrees lean (y escriban) los mismos.
for f in "$MAIN"/*.csv; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  [ -e "$DIR/$b" ] || { ln -s "$f" "$DIR/$b"; echo "enlazado $b"; }
done
[ -d "$MAIN/.venv" ] && ln -s "$MAIN/.venv" "$DIR/.venv" && echo "enlazado .venv"

if [ "$INSTALL" = 1 ]; then
  (cd "$DIR/backend" && npm ci --silent && npm run -s prisma:generate >/dev/null && echo "backend listo")
  (cd "$DIR/frontend" && npm ci --silent && echo "frontend listo")
fi

cat <<MSG

Worktree: $DIR  (rama $BRANCH, desde $BASE)
Apúntate en AGENTS_STATUS.md antes de empezar. Si ya hay otro backend/frontend arrancado:
  PORT=4001 npm run dev          (backend)
  npm run dev -- -p 3001         (frontend)
Recuerda: Amazon, Supabase y ~/Stock son los mismos para todos los worktrees.
MSG
