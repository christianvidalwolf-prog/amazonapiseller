#!/bin/bash
# ==============================================================================
# Crea (o repara) el checkout runner que usan las tareas programadas (scripts/run-from-main.sh):
#   <repo>-runner   worktree detached en origin/main, en el que nadie trabaja.
# Enlaza al checkout principal los datos y credenciales que las tareas leen y escriben:
# backend/data (Change Log, guardia, informes Ads, logs), informes-ads (PDF, decisiones.txt),
# .env, backend/.env y los CSV de la raíz. Idempotente.
#   scripts/setup-runner.sh
# ==============================================================================
set -euo pipefail

MAIN="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
RUNNER="$(dirname "$MAIN")/$(basename "$MAIN")-runner"

git -C "$MAIN" fetch -q origin main
if [ ! -d "$RUNNER" ]; then
  git -C "$MAIN" worktree add --detach "$RUNNER" origin/main
fi

link() {
  local rel="$1"
  [ -e "$MAIN/$rel" ] || { echo "falta $MAIN/$rel (no se enlaza)"; return 0; }
  if [ -L "$RUNNER/$rel" ]; then return 0; fi
  if [ -e "$RUNNER/$rel" ]; then echo "ya existe $RUNNER/$rel y no es un enlace: revísalo"; return 1; fi
  mkdir -p "$(dirname "$RUNNER/$rel")"
  ln -s "$MAIN/$rel" "$RUNNER/$rel" && echo "enlazado $rel"
}

for rel in backend/data informes-ads .env backend/.env; do link "$rel"; done
for f in "$MAIN"/*.csv; do [ -e "$f" ] && link "$(basename "$f")"; done

(cd "$RUNNER/backend" && npm ci --silent --no-audit --no-fund && npm run --silent prisma:generate && npm run --silent typecheck)
echo "Runner listo en $RUNNER ($(git -C "$RUNNER" rev-parse --short HEAD))"
