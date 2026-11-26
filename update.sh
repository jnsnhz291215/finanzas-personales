#!/usr/bin/env bash
# Actualiza la app en el servidor de punta a punta con un solo comando: verifica el entorno, descarga
# los cambios, instala dependencias si hace falta, inicia o reinicia PM2 (siempre) y comprueba que el
# bot quedó en línea. Si algo falla, dice en qué paso y muestra los logs.
#
# Uso:
#   bash update.sh                  hace todo (a mano, desde una terminal; funciona desde cualquier carpeta)
#   bash update.sh --sin-reinicio   verifica, descarga e instala, pero no toca PM2 (lo usa /update del bot,
#                                   que antes de reiniciar manda la prueba del cambio y el resumen)
#   bash update.sh --solo-reiniciar pm2 startOrReload + pm2 save + comprobación (lo usa /update del bot al final;
#                                   sirve también para el primer arranque)
#
# Variable opcional: ESPERA_PM2 (segundos entre las comprobaciones de PM2, 5 por defecto).
#
# No lee ni imprime el contenido del .env: solo comprueba que exista y toma la línea DB_ENGINE=.
# Sale con código distinto de 0 si algo falla.

set -Eeuo pipefail

PASO="Inicio"
falla() { echo "ERROR: $1"; exit 1; }
trap 'echo "ERROR: falló el paso «$PASO» (línea $LINENO de update.sh). Revisa los mensajes de arriba."' ERR

# 1. Siempre desde la carpeta del propio script (a mano o desde el bot, desde cualquier ruta)
PASO="Ubicar la carpeta del script"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
export GIT_TERMINAL_PROMPT=0

MODO="${1:-todo}"
case "$MODO" in
  todo|--sin-reinicio|--solo-reiniciar) ;;
  *) echo "Uso: bash update.sh [--sin-reinicio | --solo-reiniciar]"; exit 2 ;;
esac

DEPS="no aplica"
ANTERIOR=""
NUEVO=""

# ---------------------------------------------------------------------------
# PM2
# ---------------------------------------------------------------------------

# Nombre del proceso: el mismo que define ecosystem.config.cjs
nombre_pm2() {
  node -e "console.log(require('./ecosystem.config.cjs').apps[0].name)" 2>/dev/null
}

# "estado reinicios" del proceso en PM2 ("ausente 0" si no existe)
leer_estado_pm2() {
  { pm2 jlist 2>/dev/null || true; } | node -e '
    let d = "";
    process.stdin.on("data", c => { d += c; }).on("end", () => {
      let lista = [];
      try { lista = JSON.parse(d.slice(d.indexOf("["), d.lastIndexOf("]") + 1)); } catch {}
      const p = lista.find(x => x.name === process.argv[1]);
      console.log(p ? `${p.pm2_env.status} ${p.pm2_env.restart_time}` : "ausente 0");
    });' "$1"
}

# Falla mostrando las últimas 40 líneas de los logs del proceso
diagnosticar() {
  echo "ERROR: $1"
  echo "== Últimas 40 líneas de los logs de PM2 ($NOMBRE_PM2) =="
  pm2 logs "$NOMBRE_PM2" --lines 40 --nostream 2>&1 || true
  exit 1
}

# Inicia o reinicia SIEMPRE el proceso (haya o no cambios en git) y comprueba que quedó bien
reiniciar_pm2() {
  PASO="Reiniciar PM2"
  echo "== Reiniciando =="
  command -v pm2 >/dev/null 2>&1 || falla "PM2 no está en el PATH de este proceso: revisa el PATH o nvm."
  [ -f ecosystem.config.cjs ] || falla "No encuentro ecosystem.config.cjs en la raíz del repositorio."
  NOMBRE_PM2="$(nombre_pm2)" || falla "No pude leer el nombre del proceso en ecosystem.config.cjs."
  [ -n "$NOMBRE_PM2" ] || falla "ecosystem.config.cjs no define el nombre del proceso."
  mkdir -p logs

  # Si el script lo lanza la propia app (/update), hereda variables de PM2 que no deben pasar a --update-env
  unset pm_id pm_uptime restart_time unstable_restarts created_at exec_mode instances unique_id \
        axm_actions axm_monitor axm_options axm_dynamic vizion_running

  local est_antes rein_antes
  read -r est_antes rein_antes <<<"$(leer_estado_pm2 "$NOMBRE_PM2")"
  echo "[info] proceso $NOMBRE_PM2 antes: $est_antes, reinicios $rein_antes"

  # Marca de tiempo (con 5 s de margen) para leer solo los logs de este arranque
  local inicio
  inicio="$(date -d '5 seconds ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -v-5S +%Y-%m-%dT%H:%M:%S 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)"

  pm2 startOrReload ecosystem.config.cjs --update-env || falla "pm2 startOrReload falló."
  pm2 save || falla "pm2 save falló."
  echo "[ok] PM2 recargado y guardado"

  PASO="Comprobar que PM2 esté online"
  local espera="${ESPERA_PM2:-5}" est1 rein1
  sleep "$espera"
  read -r est1 rein1 <<<"$(leer_estado_pm2 "$NOMBRE_PM2")"
  sleep "$espera"
  read -r EST_PM2 REIN_PM2 <<<"$(leer_estado_pm2 "$NOMBRE_PM2")"
  echo "[info] proceso $NOMBRE_PM2 ahora: $EST_PM2, reinicios $REIN_PM2"

  [ "$EST_PM2" = "online" ] || diagnosticar "El proceso no está online (estado: $EST_PM2)."
  if [ "$REIN_PM2" -gt "$rein1" ] || [ $((REIN_PM2 - rein_antes)) -gt 2 ]; then
    diagnosticar "El proceso se está reiniciando en bucle (reinicios: antes $rein_antes, ahora $REIN_PM2)."
  fi
  echo "[ok] PM2: online, sin reinicios en bucle"

  # Que el proceso esté online no basta: el bot debe haber arrancado (ver los logs de este arranque)
  PASO="Comprobar que el bot arrancó"
  local logs recientes evento
  logs="$(pm2 logs "$NOMBRE_PM2" --lines 150 --nostream 2>&1 || true)"
  recientes="$(printf '%s\n' "$logs" | awk -v t="$inicio" 'substr($0,1,19) >= t')"
  evento="$(printf '%s\n' "$recientes" | grep -E 'Bot de Telegram iniciado|Bot de Telegram deshabilitado|Error al iniciar bot de Telegram|No se pudo inicializar la base de datos' | tail -1 || true)"
  case "$evento" in
    *"Bot de Telegram iniciado"*)
      BOT="Bot en línea" ;;
    *"No se pudo inicializar la base de datos"*)
      diagnosticar "El proceso está online pero la base de datos no conecta (reintenta cada 30 s): revisa DB_HOST, DB_USER, DB_PASSWORD y DB_NAME." ;;
    *"deshabilitado"*)
      diagnosticar "El proceso está online pero el bot quedó deshabilitado: falta TELEGRAM_BOT_TOKEN (¿se cargó el .env de la raíz?)." ;;
    *"Error al iniciar"*)
      diagnosticar "El proceso está online pero el bot no pudo iniciar." ;;
    *)
      BOT="Proceso online, pero no pude confirmar en los logs que el bot arrancó (revisa: pm2 logs $NOMBRE_PM2)" ;;
  esac
}

resumen() {
  echo "== Resumen =="
  echo "Hash:          ${NUEVO:0:7}${ANTERIOR:+ (antes ${ANTERIOR:0:7})}"
  echo "Dependencias:  $DEPS"
  if [ -n "${EST_PM2:-}" ]; then
    echo "PM2:           $EST_PM2, reinicios $REIN_PM2"
    echo "$BOT"
  else
    echo "PM2:           sin tocar en esta fase"
  fi
}

# ---------------------------------------------------------------------------
# Fase final del bot: solo reiniciar y comprobar
# ---------------------------------------------------------------------------

if [ "$MODO" = "--solo-reiniciar" ]; then
  NUEVO="$(git rev-parse HEAD 2>/dev/null || true)"
  reiniciar_pm2
  resumen
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Verificar herramientas y .env
# ---------------------------------------------------------------------------

PASO="Verificar herramientas"
echo "== Verificando =="
command -v git  >/dev/null 2>&1 || falla "No encuentro git: instálalo o agrégalo al PATH."
command -v node >/dev/null 2>&1 || falla "No encuentro node: revisa el PATH o nvm."
command -v npm  >/dev/null 2>&1 || falla "No encuentro npm: revisa el PATH o nvm."
command -v pm2  >/dev/null 2>&1 || falla "No encuentro pm2: instálalo (npm i -g pm2) o revisa el PATH."
echo "[ok] git  $(git --version | sed 's/^git version //')"
echo "[ok] node $(node --version)"
echo "[ok] npm  $(npm --version)"
echo "[ok] pm2  $(pm2 --version 2>/dev/null | tail -1)"

# tar solo avisa (lo usa /reset); mysqldump y mysql, también, y solo con MariaDB
revisar_herramienta() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "[ok] $1 disponible"
  else
    echo "[aviso] el proceso no encuentra $1: /reset no podrá hacer o restaurar respaldos"
  fi
}
revisar_herramienta tar

# El .env debe existir en la raíz; solo se comprueba su existencia
PASO="Verificar el .env"
[ -f .env ] || falla "No existe el archivo .env en la raíz del repositorio (copia .env.example a .env y complétalo)."
echo "[ok] .env presente en la raíz"

# Motor de base de datos: del entorno; si no, solo la línea DB_ENGINE= del .env (sin cargar el .env
# ni mostrar ninguna otra variable); si no, sqlite.
PASO="Leer DB_ENGINE"
MOTOR_DB=""
ORIGEN_MOTOR=""
if [ -n "${DB_ENGINE:-}" ]; then
  MOTOR_DB="$DB_ENGINE"
  ORIGEN_MOTOR="entorno"
else
  LINEA_MOTOR="$(grep -E '^[[:space:]]*DB_ENGINE=' .env 2>/dev/null | tail -1 || true)"
  if [ -n "$LINEA_MOTOR" ]; then
    VALOR_MOTOR="${LINEA_MOTOR#*=}"
    VALOR_MOTOR="$(printf '%s' "$VALOR_MOTOR" | tr -d '\r' | sed -E "s/^[[:space:]]+//; s/[[:space:]]+#.*\$//; s/[[:space:]]+\$//; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/")"
    if [ -n "$VALOR_MOTOR" ]; then
      MOTOR_DB="$VALOR_MOTOR"
      ORIGEN_MOTOR=".env"
    fi
  fi
  unset LINEA_MOTOR VALOR_MOTOR
fi
if [ -z "$MOTOR_DB" ]; then
  MOTOR_DB="sqlite"
  ORIGEN_MOTOR="por defecto"
  echo "[aviso] DB_ENGINE no definido en .env, se asume sqlite"
fi
MOTOR_DB="$(printf '%s' "$MOTOR_DB" | tr '[:upper:]' '[:lower:]')"
echo "[ok] motor de base de datos: $MOTOR_DB ($ORIGEN_MOTOR)"

if [ "$MOTOR_DB" = "mariadb" ] || [ "$MOTOR_DB" = "mysql" ]; then
  revisar_herramienta mysqldump
  revisar_herramienta mysql
else
  echo "mysqldump y mysql: no se revisan (DB_ENGINE=$MOTOR_DB)"
fi

PASO="Verificar el repositorio"
RAMA="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || falla "No pude leer la rama: ¿esto es un repositorio git?"
[ "$RAMA" != "HEAD" ] || falla "El repositorio no está en ninguna rama (HEAD suelto)."
echo "[ok] rama $RAMA"

# El remoto debe responder en 20 segundos (si existe `timeout`)
if command -v timeout >/dev/null 2>&1; then
  REMOTO_OK=0; timeout 20 git ls-remote --heads origin >/dev/null 2>&1 || REMOTO_OK=$?
else
  REMOTO_OK=0; git ls-remote --heads origin >/dev/null 2>&1 || REMOTO_OK=$?
fi
[ "$REMOTO_OK" -eq 0 ] || falla "No hay acceso al repositorio remoto: falta la deploy key o no hay conexión."
echo "[ok] repositorio remoto responde"

# ---------------------------------------------------------------------------
# 3. Descargar los cambios
# ---------------------------------------------------------------------------

PASO="Descargar cambios (git pull)"
ANTERIOR="$(git rev-parse HEAD)"
echo "== Descargando cambios =="
git pull --ff-only || falla "git pull falló (revisa cambios locales o conflictos)."
NUEVO="$(git rev-parse HEAD)"

echo "hash anterior: ${ANTERIOR:0:7}"
echo "hash nuevo:    ${NUEVO:0:7}"

# ---------------------------------------------------------------------------
# 4. Dependencias: si cambiaron package.json/package-lock.json o si falta node_modules
# ---------------------------------------------------------------------------

PASO="Instalar dependencias"
INSTALAR=""
if [ ! -d node_modules ]; then
  INSTALAR="falta la carpeta node_modules"
elif [ "$ANTERIOR" != "$NUEVO" ]; then
  CAMBIADOS="$(git diff --name-only "$ANTERIOR" "$NUEVO")"
  if grep -qE '^(package\.json|package-lock\.json)$' <<<"$CAMBIADOS"; then
    INSTALAR="cambiaron package.json o package-lock.json"
  fi
fi

if [ -n "$INSTALAR" ]; then
  echo "== Instalando dependencias ($INSTALAR) =="
  if [ -f package-lock.json ]; then
    npm ci --omit=dev || falla "npm ci falló."
  else
    npm install --omit=dev || falla "npm install falló."
  fi
  DEPS="instaladas ($INSTALAR)"
  echo "[ok] dependencias instaladas"
else
  DEPS="sin cambios"
  echo "Las dependencias no cambiaron."
fi

# ---------------------------------------------------------------------------
# 5. Migraciones: el proyecto no tiene un paso aparte; las tablas se crean o actualizan solas
#    (inicializarDB) cada vez que arranca la app
# ---------------------------------------------------------------------------

echo "Migraciones: automáticas al arrancar la app (no hay un paso aparte)."

if [ "$ANTERIOR" = "$NUEVO" ]; then
  echo "Ya estaba al día."
fi

# En dos fases, el bot decide: sin cambios no reinicia, y con cambios manda la prueba y reinicia después
if [ "$MODO" = "--sin-reinicio" ]; then
  resumen
  exit 0
fi

# ---------------------------------------------------------------------------
# 6 y 7. Iniciar o reiniciar SIEMPRE (aunque no haya cambios) y comprobar
# ---------------------------------------------------------------------------

reiniciar_pm2

# ---------------------------------------------------------------------------
# 9. Resumen
# ---------------------------------------------------------------------------

PASO="Resumen"
resumen
