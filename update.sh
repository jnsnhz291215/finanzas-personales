#!/usr/bin/env bash
# Actualiza la app en el servidor: verifica el entorno, descarga los cambios, instala dependencias
# solo si cambiaron y recarga PM2.
#
# Uso:
#   bash update.sh                  hace todo (a mano, desde una terminal)
#   bash update.sh --sin-reinicio   verifica, descarga e instala, pero no toca PM2 (lo usa /update del bot,
#                                   que antes de reiniciar manda la prueba del cambio y el resumen)
#   bash update.sh --solo-reiniciar solo pm2 startOrReload y pm2 save (sirve también para el primer arranque) (lo usa /update del bot al final)
#
# No lee ni imprime .env ni secretos. Sale con código distinto de 0 si algo falla.

set -u
cd "$(dirname "$0")" || exit 1
export GIT_TERMINAL_PROMPT=0

MODO="${1:-todo}"
case "$MODO" in
  todo|--sin-reinicio|--solo-reiniciar) ;;
  *) echo "Uso: bash update.sh [--sin-reinicio | --solo-reiniciar]"; exit 2 ;;
esac

falla() { echo "ERROR: $1"; exit 1; }

reiniciar_pm2() {
  echo "== Reiniciando =="
  command -v pm2 >/dev/null 2>&1 || falla "PM2 no está en el PATH de este proceso: revisa el PATH o nvm."
  pm2 startOrReload ecosystem.config.cjs --update-env || falla "pm2 startOrReload falló."
  pm2 save || falla "pm2 save falló."
  echo "[ok] PM2 recargado y guardado"
}

if [ "$MODO" = "--solo-reiniciar" ]; then
  reiniciar_pm2
  exit 0
fi

echo "== Verificando =="
command -v git  >/dev/null 2>&1 || falla "No encuentro git: instálalo o agrégalo al PATH."
command -v node >/dev/null 2>&1 || falla "No encuentro node: revisa el PATH o nvm."
command -v npm  >/dev/null 2>&1 || falla "No encuentro npm: revisa el PATH o nvm."
echo "[ok] git  $(git --version | sed 's/^git version //')"
echo "[ok] node $(node --version)"
echo "[ok] npm  $(npm --version)"

# Herramientas de respaldo de /reset: solo avisan, no impiden actualizar. mysqldump y mysql solo
# importan con DB_ENGINE=mariadb (el bot pasa esa variable; a mano puede no estar definida).
revisar_herramienta() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "[ok] $1 disponible"
  else
    echo "[aviso] el proceso no encuentra $1: /reset no podrá hacer o restaurar respaldos"
  fi
}
revisar_herramienta tar
if [ "${DB_ENGINE:-sqlite}" = "mariadb" ] || [ "${DB_ENGINE:-sqlite}" = "mysql" ]; then
  revisar_herramienta mysqldump
  revisar_herramienta mysql
else
  echo "mysqldump y mysql: no se revisan (DB_ENGINE=${DB_ENGINE:-sqlite})"
fi

RAMA="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || falla "No pude leer la rama: ¿esto es un repositorio git?"
[ "$RAMA" != "HEAD" ] || falla "El repositorio no está en ninguna rama (HEAD suelto)."
echo "[ok] rama $RAMA"

# El remoto debe responder en 20 segundos (si existe `timeout`)
if command -v timeout >/dev/null 2>&1; then
  timeout 20 git ls-remote --heads origin >/dev/null 2>&1
else
  git ls-remote --heads origin >/dev/null 2>&1
fi
[ $? -eq 0 ] || falla "No hay acceso al repositorio remoto: falta la deploy key o no hay conexión."
echo "[ok] repositorio remoto responde"

ANTERIOR="$(git rev-parse HEAD)"
echo "== Descargando cambios =="
git pull --ff-only || falla "git pull falló."
NUEVO="$(git rev-parse HEAD)"

echo "hash anterior: ${ANTERIOR:0:7}"
echo "hash nuevo:    ${NUEVO:0:7}"

if [ "$ANTERIOR" = "$NUEVO" ]; then
  echo "Ya estaba al día."
  exit 0
fi

if git diff --name-only "$ANTERIOR" "$NUEVO" | grep -qE '^(package\.json|package-lock\.json)$'; then
  echo "== Instalando dependencias (cambiaron package.json o package-lock.json) =="
  npm ci --omit=dev || falla "npm ci falló."
  echo "[ok] dependencias instaladas"
else
  echo "Las dependencias no cambiaron."
fi

if [ "$MODO" = "todo" ]; then
  reiniciar_pm2
fi
echo "Listo."
