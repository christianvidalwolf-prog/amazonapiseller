#!/bin/bash
# ==============================================================================
# Ejecuta una tarea programada (launchd) desde un checkout que solo sigue origin/main.
#   scripts/run-from-main.sh run_ads_daily.sh
#
# El checkout principal es donde trabajan los agentes (ramas, stashes, archivos sin
# commit), así que las tareas programadas no corren desde ahí sino desde el runner:
#   <repo>-runner   worktree sin rama (detached) en origin/main, en el que nadie trabaja.
# Los datos y credenciales siguen en el checkout principal; el runner los enlaza
# (scripts/setup-runner.sh): backend/data, informes-ads, .env, backend/.env y los CSV.
#
# Antes de cada ejecución: git fetch + checkout de origin/main; npm ci y prisma generate
# si cambió el lockfile; typecheck del backend. Si algo falla se queda en el último
# commit que pasó y avisa con una notificación. Log: backend/data/logs/runner.log
# ==============================================================================
# Todo va dentro de main(): bash lee el script entero antes de ejecutarlo, así el
# checkout que cambia este mismo archivo no afecta a la ejecución en curso.

main() {
  set -uo pipefail
  export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  local task="${1:?Uso: scripts/run-from-main.sh <script del repo>}"
  local runner
  runner="$(cd "$(dirname "$0")/.." && pwd)"
  local log="$runner/backend/data/logs/runner.log"
  mkdir -p "$(dirname "$log")"
  cd "$runner" || return 1

  notify() { osascript -e "display notification \"$1\" with title \"Runner main\"" >/dev/null 2>&1 || true; }
  say() { echo "[$(date '+%F %T')] $task: $*" >> "$log"; }

  local prev
  prev="$(git rev-parse HEAD)"
  if git fetch -q origin main && git checkout -q --detach origin/main; then
    say "en $(git rev-parse --short HEAD) (antes $(git rev-parse --short "$prev"))"
  else
    say "fetch/checkout de origin/main falló; sigue en $(git rev-parse --short "$prev")"
    notify "No se pudo actualizar a origin/main; $task corre con el commit anterior"
  fi

  install_deps() {
    (cd backend && npm ci --silent --no-audit --no-fund && npm run --silent prisma:generate) >> "$log" 2>&1
  }
  if [ ! -d backend/node_modules ] || ! git diff --quiet "$prev" HEAD -- backend/package-lock.json; then
    say "dependencias: npm ci"
    install_deps || say "npm ci falló"
  fi

  if ! (cd backend && npm run --silent typecheck) >> "$log" 2>&1; then
    local bad
    bad="$(git rev-parse --short HEAD)"
    say "typecheck falló en $bad; vuelve a $(git rev-parse --short "$prev")"
    git checkout -q --detach "$prev"
    git diff --quiet "$bad" HEAD -- backend/package-lock.json || install_deps
    notify "main ($bad) no pasa el typecheck; $task corre con el commit anterior"
  fi

  say "lanza $task"
  exec /bin/bash "$runner/$task"
}

main "$@"
exit $?
