# Finanzas Personales - Juan

Aplicación web de finanzas personales diseñada para un solo usuario. Interfaz 100% en español de Chile con formato de montos en pesos chilenos (CLP).

## 🎯 Características

### Gestión de Cuentas
- Registro de cuentas bancarias (corriente, vista, ahorro)
- Gestión de tarjetas de crédito con cupo, fechas de facturación y vencimiento
- Tarjetas de débito

### Importación de Cartolas
- Soporta archivos CSV, Excel (XLSX/XLS) y PDF
- Detección automática de formato para bancos chilenos:
  - Banco de Chile
  - Banco Falabella / CMR
  - Formato genérico
- Vista previa antes de confirmar
- Prevención de duplicados por hash de archivo
- Autocategorización automática basada en reglas

### Movimientos
- Registro manual de cargos y abonos
- Filtros por mes, año, cuenta y categoría
- Categorización manual y automática
- Historial completo de transacciones

### Tarjetas Prestadas / Gastos de Terceros
- Marcar movimientos como préstamos
- Seguimiento de deudas por persona (quién te debe, a quién debes)
- Registro de pagos/abonos
- Adjuntar respaldos (fotos, PDFs de boletas)

### Panel Principal
- Resumen mensual de ingresos, gastos y saldo
- Gráfico de gastos por categoría
- Evolución de últimos 6 meses
- Estado de cupo de tarjetas de crédito
- Alertas de próximos vencimientos
- Resumen de deudas pendientes

### Categorías Personalizables
- Crear categorías con colores e iconos
- Reglas de autocategorización por texto
- Aplicación automática al importar

## 🛠 Stack Tecnológico

- **Backend**: Node.js 22 + Express
- **Base de Datos**: MariaDB 10.5+
- **Frontend**: React 18 + Vite
- **Estilos**: Tailwind CSS
- **Gráficos**: Chart.js
- **Iconos**: Font Awesome 6

## 📋 Requisitos Previos

- Node.js 18+ (recomendado 22+)
- MariaDB 10.5+ o MySQL 8+
- PM2 (para producción)
- Servidor Linux con acceso SSH
- Cloudflare Tunnel configurado

## 🚀 Instalación en Servidor de Producción

### 1. Preparar el Servidor

```bash
# Conectarse al servidor
ssh usuario@servidor

# Clonar el repositorio
cd /ruta/donde/alojar/aplicaciones
git clone <url-del-repo> finanzas-personales
cd finanzas-personales
```

### 2. Configurar Base de Datos

```bash
# Conectarse a MariaDB como root
mysql -u root -p

# Crear la base (utf8mb4) con el nombre que pondrás en DB_NAME
CREATE DATABASE finanzas_personales_juan CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

# Crear el usuario y permisos (editar la contraseña antes)
source database/crear_usuario.sql
# O ejecutar manualmente:
# CREATE USER 'finanzas_juan'@'localhost' IDENTIFIED BY 'tu_contraseña_segura';
# GRANT ALL PRIVILEGES ON finanzas_personales_juan.* TO 'finanzas_juan'@'localhost';
# FLUSH PRIVILEGES;

# Salir
exit
```

> **Las tablas se crean solas.** Con `DB_ENGINE=mariadb`, al arrancar la app aplica `database/schema.sql` (solo las sentencias
> idempotentes: sin `CREATE DATABASE`, `USE` ni `ALTER TABLE`) y las migraciones sobre la base vacía que creaste; no hace falta
> ejecutar `source database/schema.sql` a mano (si ya lo hiciste, no pasa nada). Las categorías por defecto solo se insertan si la tabla
> está vacía. El pool de MariaDB devuelve las fechas como texto (`2026-11-25`) y los DECIMAL como números, igual que SQLite.
>
> **Si la base no conecta** (credenciales, MariaDB caído, base inexistente), el proceso no se cierra: escribe en el log el motivo en
> lenguaje simple (nunca la contraseña) y reintenta cada 30 s (`DB_REINTENTO_SEGUNDOS`), así PM2 no lo reinicia en bucle. El bot arranca
> cuando la base responde. Las promesas rechazadas sin manejar se registran y no tumban el arranque.

### 3. Configurar el Almacenamiento

Todos los archivos (cartolas, comprobantes y lo que se manda al bot) viven bajo **una sola raíz**,
`FINANZAS_STORAGE`, ordenados por tipo y por mes de recepción (hora de Chile):

```
<FINANZAS_STORAGE>/
├── cartolas/{YYYY-MM}/       cartolas importadas (web y bot)
├── comprobantes/{YYYY-MM}/   comprobantes de cuotas y respaldos de movimientos
├── archivos/{YYYY-MM}/       otros archivos que se mandan al bot
└── tmp/
```

- **Producción** (junto a las apps de Basalto): `FINANZAS_STORAGE=/home/basalto/apps/finanzas-juan/storage`
- **Desarrollo**: si la variable está vacía se usa `storage/` en la raíz del repo (ignorada por git).
- El servidor crea las carpetas al arrancar; la raíz debe poder escribirse.
- En la base de datos se guarda la ruta relativa a la raíz, por ejemplo `comprobantes/2026-11/respaldo_cuota_123_foto.jpg`.
- `CARTOLAS_PATH` y `RESPALDOS_PATH` están **obsoletas**: si siguen definidas mandan para su tipo y el servidor avisa al
  arrancar. Los registros anteriores (`/uploads/respaldos/<archivo>`, rutas absolutas de cartolas) se siguen resolviendo y los
  archivos existentes **no se mueven**.

```bash
mkdir -p /home/basalto/apps/finanzas-juan/storage
chmod 755 /home/basalto/apps/finanzas-juan/storage
```

### 4. Configurar Variables de Entorno

```bash
# Copiar el archivo de ejemplo
cp .env.example .env

# Editar con tus valores
nano .env
```

Configurar:
```env
NODE_ENV=production
PORT=3005

# Web: por defecto no se expone nada por HTTP (solo el bot). Ver la nota "La web está deshabilitada" más abajo
WEB_HABILITADA=false
HOST=127.0.0.1

# Motor de base de datos: sqlite (por defecto) o mariadb. En el servidor: mariadb
DB_ENGINE=mariadb

# Base de Datos MariaDB (usuario exclusivo, BD separada). Obligatorias con DB_ENGINE=mariadb:
# DB_HOST, DB_USER, DB_PASSWORD y DB_NAME (DB_PORT es opcional, 3306 por defecto)
DB_HOST=localhost
DB_PORT=3306
DB_USER=finanzas_juan
DB_PASSWORD=tu_contraseña_segura
DB_NAME=finanzas_personales_juan

# Generar un secreto aleatorio largo
SESSION_SECRET=genera_uno_con_openssl_rand_base64_32

# Contraseña inicial (cambiarla después del primer login)
ADMIN_PASSWORD=cambiar123

# Raíz del almacenamiento (ver la sección Configurar el Almacenamiento)
FINANZAS_STORAGE=/home/basalto/apps/finanzas-juan/storage
```

> **Motor de base de datos.** Se elige con `DB_ENGINE`: `sqlite` (por defecto, archivo `finanzas.db`, para desarrollo) o `mariadb`.
> Sin `DB_ENGINE` la app usa SQLite aunque existan las variables `DB_*`: en el servidor hay que definir `DB_ENGINE=mariadb`
> explícitamente. Con `mariadb` el servidor no arranca si falta `DB_HOST`, `DB_USER`, `DB_PASSWORD` o `DB_NAME`, y un valor distinto
> de `sqlite`/`mariadb` también es un error. Al arrancar escribe en el log `Motor de base de datos: sqlite|mariadb`, sin host,
> usuario ni contraseña. Los datos de SQLite y de MariaDB son independientes: cambiar de motor no copia los datos.
> `/reset` y `/update` además esperan `tar` (y, con MariaDB, `mysqldump` y `mysql`) en el PATH del proceso; `/update` y `update.sh`
> avisan si PM2 no los ve.

> **La web está deshabilitada por defecto.** Con `WEB_HABILITADA=false` (o sin la variable) el servidor no levanta Express ni escucha
> ningún puerto: solo corren el bot de Telegram y las tareas internas (limpieza de `tmp/`, chequeo de arranque). Con
> `WEB_HABILITADA=true` Express escucha **solo en `HOST`** (por defecto `127.0.0.1`, nunca `0.0.0.0` ni `::`; si los pones, la web no
> arranca) en el puerto `PORT`. La web tampoco arranca si falta `ADMIN_PASSWORD` o sigue siendo `cambiar123`; el motivo queda en el
> log. `/status` muestra una sección **Web** ("Deshabilitada" o "Escuchando en 127.0.0.1:3005") y marca error si algo escucha fuera de
> localhost. `SERVIR_FRONTEND` solo importa cuando la web está habilitada. Si necesitas la web desde internet, ponla detrás de un túnel
> (Cloudflare Tunnel) que apunte a `http://127.0.0.1:PUERTO` en el mismo equipo.

### 5. Instalar Dependencias

```bash
# Instalar dependencias del backend
npm install

# Instalar dependencias del frontend
cd client
npm install
cd ..
```

### 6. Compilar el Frontend (opcional)

La aplicación se puede usar solo desde el bot de Telegram. El servidor **no sirve la web por defecto**:
la API y el bot funcionan igual y no hace falta compilar el frontend.

Si quieres usar también la web, compílala y actívala en el `.env`:

```bash
npm run build:client
```

```env
SERVIR_FRONTEND=true
```

Con `SERVIR_FRONTEND=false` (o sin la variable) el servidor no sirve `client/dist`. El código del frontend
se conserva en `client/`.

### 7. Configurar PM2

> **La app corre en modo `fork` con una sola instancia** (`exec_mode: 'fork'`, `instances: 1`): el bot de Telegram usa polling y no puede
> correr en dos procesos (PM2 pasa a modo cluster si solo se indica `instances`).
>
> **La app debe correr bajo PM2 con `autorestart`.** `ecosystem.config.cjs` ya lo trae (`autorestart: true` y
> `NODE_ENV=production`). Los comandos `/reboot` y `/update` del bot terminan el proceso con `process.exit(0)` y es PM2 quien
> lo vuelve a levantar; sin PM2 (o sin autorestart) la app se quedaría apagada.

```bash
# Iniciar con PM2
pm2 start ecosystem.config.cjs

# Guardar configuración para auto-inicio
pm2 save
pm2 startup

# Verificar que esté corriendo
pm2 status
pm2 logs finanzas-personales
```

### 8. Configurar Cloudflare Tunnel (solo si habilitas la web)

Con `WEB_HABILITADA=false` (por defecto) no hay nada que exponer y este paso no hace falta.

Agregar la ruta al túnel existente:

```yaml
# En tu archivo de configuración de Cloudflare Tunnel
# (usualmente en ~/.cloudflared/config.yml o similar)

ingress:
  # ... otras rutas existentes ...
  
  - hostname: finanzas.tudominio.cl
    service: http://localhost:3005
  
  # ... keep alive al final ...
  - service: http_status:404
```

Reiniciar el túnel:
```bash
# El comando depende de cómo tengas configurado el túnel
sudo systemctl restart cloudflared
# o
pm2 restart cloudflare-tunnel
```

### 9. Primer Acceso (solo con la web habilitada)

1. Abrir en el navegador: `https://finanzas.tudominio.cl`
2. Iniciar sesión con:
   - Email: `juan@finanzas.cl`
   - Contraseña: la que configuraste en `ADMIN_PASSWORD` (por defecto `cambiar123`)
3. **IMPORTANTE**: Cambiar la contraseña inmediatamente

## 🔧 Desarrollo Local

```bash
# Terminal 1: Backend
npm run dev

# Terminal 2: Frontend
cd client
npm run dev
```

Abrir `http://localhost:5173` en el navegador.

## 📁 Estructura del Proyecto

```
finanzas-personales/
├── server/                 # Backend Node.js
│   ├── index.js           # Servidor Express
│   ├── db.js              # Conexión a BD
│   ├── middleware/        # Middleware (auth)
│   └── routes/            # Rutas de API
│       ├── auth.js
│       ├── cuentas.js
│       ├── categorias.js
│       ├── movimientos.js
│       ├── importar.js
│       ├── prestamos.js
│       └── dashboard.js
├── client/                # Frontend React
│   ├── src/
│   │   ├── pages/        # Páginas principales
│   │   ├── components/   # Componentes reutilizables
│   │   └── utils/        # Utilidades (API, formateo)
│   └── package.json
├── database/              # Scripts SQL
│   ├── schema.sql        # Esquema completo
│   └── crear_usuario.sql # Usuario y permisos
├── uploads/              # Archivos subidos (local, usar NAS en prod)
│   ├── cartolas/
│   └── respaldos/
├── .env.example
├── ecosystem.config.cjs  # Configuración PM2
└── README.md
```

## 📝 Formatos de Cartola Soportados

### CSV/Excel - Banco de Chile
Columnas esperadas:
- `Fecha` o `Fecha Contable`: DD-MM-YYYY
- `Descripción` o `Glosa`: Texto del movimiento
- `Cargo`: Monto de cargos
- `Abono`: Monto de abonos

### CSV/Excel - Banco Falabella / CMR
Columnas esperadas:
- `Fecha`: DD-MM-YYYY
- `Establecimiento` o `Comercio`: Descripción
- `Monto` o `Importe`: Valor (detecta signo)

### Formato Genérico
Cualquier CSV/Excel con:
- Columna de fecha
- Columna de descripción
- Columna de monto (o cargo/abono separados)

### PDF
- Extracción básica de texto
- Busca patrones de fecha y monto
- Puede requerir revisión manual

## 🔐 Seguridad

- **Autenticación obligatoria**: Todos los datos requieren login
- **Contraseñas hasheadas**: bcrypt con salt automático
- **Sesiones seguras**: Express-session con cookies httpOnly
- **Base de datos aislada**: Usuario con permisos solo en su BD
- **Sin branding corporativo**: Aplicación 100% personal
- **Archivos en NAS**: Respaldos almacenados fuera del código

## 🆘 Solución de Problemas

### Error de conexión a base de datos
```bash
# Verificar que MariaDB esté corriendo
sudo systemctl status mariadb

# Verificar credenciales en .env
mysql -u finanzas_juan -p finanzas_personales_juan
```

### Error de permisos en archivos
```bash
# Verificar permisos en las carpetas de uploads
ls -la /ruta/al/nas/finanzas-juan/

# Ajustar propietario si es necesario
sudo chown -R usuario:usuario /ruta/al/nas/finanzas-juan/
```

### PM2 no inicia
```bash
# Ver logs de error
pm2 logs finanzas-personales --err

# Reiniciar
pm2 restart finanzas-personales

# Verificar que el puerto 3005 esté libre
netstat -tulpn | grep 3005
```

### Frontend no se ve en producción
```bash
# Recompilar el frontend
cd client
npm run build
cd ..

# Reiniciar PM2
pm2 restart finanzas-personales
```

## 📊 Uso de la Aplicación

### Importar una Cartola
1. Ir a **Importar**
2. Seleccionar la cuenta correspondiente
3. Subir el archivo (CSV, Excel o PDF)
4. Revisar la vista previa
5. Confirmar importación

### Registrar un Préstamo
1. Crear el movimiento normalmente
2. Marcar checkbox "Es préstamo / tarjeta prestada"
3. Ingresar el nombre de la persona
4. Guardar

### Ver y Saldar Deudas
1. Ir a **Préstamos**
2. Seleccionar la persona
3. Ver movimientos y pagos
4. Clic en "Registrar Pago" para abonar

### Crear Reglas de Autocategorización
1. Ir a **Categorías**
2. Clic en "Nueva Regla"
3. Ingresar texto a buscar (ej: "uber")
4. Seleccionar categoría (ej: "Transporte")
5. Al importar, movimientos con "uber" se categorizarán automáticamente

## 🤖 Bot de Telegram

La aplicación incluye un bot de Telegram para registrar gastos/ingresos y consultar información desde tu móvil.

### Configuración del Bot

1. **Crear el bot en Telegram**:
   - Habla con [@BotFather](https://t.me/botfather) en Telegram
   - Envía `/newbot` y sigue las instrucciones
   - Guarda el token que te entrega (parecido a `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

2. **Obtener tu Chat ID**:
   - Busca tu bot en Telegram y envíale `/miid`
   - El bot te responderá con tu chat ID (un número como `123456789`)
   - Copia este número

3. **Configurar en el servidor**:
   
   Si aún no tienes un archivo `.env`, créalo desde el ejemplo:
   ```bash
   cp .env.example .env
   ```
   
   Edita tu archivo `.env` y agrega:
   ```env
   # Token del bot (obtenido de @BotFather)
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   
   # Tu chat ID (obtenido con /miid)
   TELEGRAM_ALLOWED_CHAT_IDS=123456789
   ```
   
   Si quieres autorizar varios chat IDs (por ejemplo, tu móvil y tu PC), sepáralos con comas:
   ```env
   TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
   ```

4. **Reiniciar el servidor**:
   ```bash
   pm2 restart finanzas-personales
   pm2 logs finanzas-personales
   ```
   
   Deberías ver: `✓ Bot de Telegram iniciado (long polling)`

### Uso del Bot

#### Registrar Gastos e Ingresos

Escribe en lenguaje natural. El bot entiende:

**Montos**:
- `12500`, `12.500`, `$12.500` (formato chileno)
- `5 lucas`, `5k` (miles de pesos)

**Fechas**:
- `hoy`, `ayer`, `anteayer`
- `lunes`, `martes`, etc. (asume la semana pasada)
- `15/11`, `15-11` (día/mes del año actual)

**Medios de pago**:
- `con débito`, `con crédito`, `con la CMR`
- `en efectivo`, `por transferencia`

**Ejemplos**:
```
ayer pagué 12.500 en el super con débito
gasté 5 lucas en uber con la CMR
hoy pagué $2.500 en el metro
me pagaron 300.000 de sueldo
el 15/11 compré en jumbo con crédito $45.000
```

El bot te mostrará un resumen y te pedirá confirmar antes de guardar.

#### Comandos Disponibles

La lista sale de un solo lugar (`server/telegram/comandos.js`), la misma de `/help`, del aviso de "comando que no existe" y del menú "/" de Telegram (que muestra solo `/help`, `/plan`, `/cuentas`, `/cuotas`, `/status` y `/update`). `comandos.test.js` revisa el código y falla si un comando registrado no está en la lista o si la lista tiene uno que ya no existe.

**General**

- `/start` - Saludo y esta lista de comandos
- `/help` (o `/ayuda`) - Esta lista de comandos y ejemplos
- `/miid` - Ver tu chat ID (para autorizarlo en el servidor)
- `/status` - Estado de la app: servidor, base de datos, Gemini, Telegram y más

**Finanzas**

- `/resumen` - Resumen del mes: ingresos, gastos y saldo
- `/ultimos` - Últimos movimientos, con botones para editar o borrar
- `/buscar <texto o mes>` - Buscar movimientos (por ejemplo: /buscar uber octubre)
- `/gastos` - Gastos del mes por categoría y uso de tus tarjetas de crédito
- `/plan [config | ingreso <monto> | 50 30 20]` - Plan de ahorro del mes: cuánto puedes gastar
- `/deudas` - Quién te debe y cuánto
- `/pago <persona> <monto>` - Registrar el pago de una deuda (por ejemplo: /pago Pedro 20 mil)

**Cuotas y fijos**

- `/cuotas [nueva ... | cartola ...]` - Compras en cuotas y lo del mes por titular
- `/fijo <nombre> <monto> [el <día>]` - Agregar un gasto fijo (por ejemplo: /fijo arriendo 350 mil el 5)
- `/fijos` - Ver tus gastos fijos, editarlos o desactivarlos

**Cuentas y datos**

- `/cuentas` (o `/datosguardados`) - Tus cuentas con vínculos, titulares, cuotas y totales
- `/savecard <descripción>` (o `/nuevacuenta`) - Crear una cuenta o tarjeta (con los últimos 4 dígitos)
- `/borrarcuenta [número]` - Desactivar una cuenta (sus movimientos se conservan)
- `/savetrans` - Guardar tus datos de transferencia (para que te depositen)
- `/misdatos` - Ver tus datos de transferencia guardados
- `/datos <alias o banco>` - Pedir los datos de transferencia de una de tus cuentas
- `/borrardatos [número]` - Desactivar datos de transferencia

**Categorías y reglas**

- `/categorias` - Ver las categorías
- `/categoria nueva <nombre>` - Crear una categoría
- `/regla <texto> <categoría>` - Categorizar solo lo que contenga ese texto (sin argumentos: lista las reglas)

**Sistema**

- `/update` - Actualizar la app y reiniciarla (solo en el servidor)
- `/reboot` - Reiniciar la app (solo en el servidor)
- `/reset` - Empezar de cero: respaldo, doble confirmación y opción de restaurar

#### Importar Cartolas

Envía directamente un archivo de cartola (**CSV, Excel o PDF**) al bot y se importa completo desde Telegram:

1. El bot lee los movimientos y muestra un resumen (cantidad, rango de fechas, cargos y abonos).
2. **PDF:** la lectura es menos confiable, así que antes de elegir la cuenta muestra una **vista previa** de los primeros
   movimientos y pide confirmar con los botones *Importar* o *Cancelar*. Primero intenta leerlo con reglas sobre el texto; si
   no alcanzan, y hay `GEMINI_API_KEY`, usa Gemini **solo con el texto extraído**, con los números de cuenta y los RUT
   enmascarados, y descarta cualquier movimiento cuyo monto no aparezca en el texto.
3. Eliges la cuenta. Se aplican las reglas de autocategorización y se evitan duplicados (mismo archivo = mismo hash).
4. Si una transferencia calza con el alias de cartola de una compra en cuotas, el bot pregunta con botones si es un pago de cuota.

Mientras no confirmes, el archivo espera en `tmp/` y solo pasa a `cartolas/{YYYY-MM}/` al importar. Los archivos sin confirmar se
borran solos a las 24 horas (se revisa al arrancar el servidor y cada hora). Si un archivo no se puede leer de ninguna forma, el
bot lo dice y lo deja guardado en `cartolas/{YYYY-MM}/`.

#### Enviar Respaldos

Envía fotos de boletas o comprobantes. Se guardarán en la carpeta de uploads del servidor.

### Interpretación con Gemini (opcional)

El bot primero lee tus mensajes con un parser de reglas. Si no encuentra el monto o la categoría, puede pedirle ayuda a Gemini para entender mensajes escritos de forma libre.

1. Crea una API key en [Google AI Studio](https://aistudio.google.com/apikey).
2. Agrega a tu `.env`:
   ```env
   GEMINI_API_KEY=tu_api_key
   # Opcional; por defecto gemini-2.5-flash
   GEMINI_MODEL=gemini-2.5-flash
   ```
3. Reinicia el servidor.

- Sin `GEMINI_API_KEY` el bot funciona exactamente igual que antes.
- Si Gemini tarda más de 8 segundos o falla, el bot sigue con el resultado de las reglas (o responde que no detectó un monto).
- Al usarlo, **el texto del mensaje, la fecha de hoy, tus nombres de categorías y los medios de pago se envían a Google**. No se envían montos de la base de datos ni otros movimientos.
- Los errores se registran solo con código y mensaje, nunca con la key.
- Los montos aproximados ("57 mil y algo") se marcan en la confirmación; puedes responder con el número exacto antes de apretar Guardar.

### Uso en lenguaje natural

El bot se usa casi sin comandos: escribe como hablas o manda un archivo. Un enrutador de intenciones
(`server/telegram/intenciones.js`) prueba primero reglas rápidas (sin tildes ni mayúsculas) y, si no alcanzan y hay
`GEMINI_API_KEY`, consulta a Gemini con un prompt corto. Los comandos siguen existiendo como respaldo.

| Escribes | Qué hace |
|---|---|
| `almuerzo 5500 débito falabella`, `me pagaron 400 mil` | Registra un gasto o ingreso (con confirmación) |
| `pagué cuota tía mac 7/12` (también con la foto del comprobante) | Paga una cuota |
| `compré audífonos en 6 cuotas de 15 mil con la tarjeta de la tía` | Crea una compra en cuotas |
| `cuánto gasté este mes`, `cuánto llevo en comida` | Gastos del mes o de una categoría |
| `cuánto puedo gastar`, `cuánto debería ahorrar` | Plan de ahorro |
| `pásame los datos de la mercado pago` | Datos de transferencia |
| `qué cuentas tengo`, `cuánto le debo a la tía`, `busca uber de octubre`, `qué puedes hacer` | Cuentas, cuotas, búsqueda y ayuda |

- **Si no está claro, pregunta con botones** (qué quisiste decir, el monto que falta, la cuenta). Todo lo que escribe en la base de
  datos pide confirmación; cuando la intención la dedujo Gemini, la confirmación agrega el botón *Corregir*.
- **Privacidad:** a Gemini nunca viaja nada de datos de transferencia, RUT, correos ni números de cuenta: si el mensaje parece
  traer algo así, ni siquiera se consulta. Guardar cuentas y datos de transferencia sigue siendo solo con `/savecard` y `/savetrans`.
- **Archivos:** un PDF, CSV o Excel va directo a importar la cartola. Una foto sin texto pregunta si es el comprobante de una
  cuota, de otro gasto, o solo guardarla.
- **Reconocer la cuenta por los dígitos:** al leer una cartola (CSV, Excel o PDF) el bot busca en el encabezado los últimos 4
  dígitos de la tarjeta o de la cuenta (`**** 1234`, `XXXX-1234`, `terminada en 1234`, `N° cuenta ...1234`) y los compara con
  `ultimos4` (tarjeta) y `ultimos4_cuenta` (número de cuenta) de tus cuentas; si coinciden, lo dice en el resumen ("Cuenta
  detectada: Falabella débito •6958") y la sugiere antes que el banco. Si trae dígitos que no son de ninguna cuenta y eliges la
  cuenta a mano, el bot pregunta con botones si guardas esa terminación para reconocerla la próxima vez. Solo se leen y se guardan
  4 dígitos: nunca el número completo, y no se registran en consola. En `/savecard` puedes indicar `cuenta terminada en 1234`.
  Los números de cuenta (`cuenta ...`) solo se buscan en el encabezado, antes de la primera línea que parezca un movimiento (fecha y
  monto), para no confundir una descripción como "transferencia a cuenta 1234" con la cuenta de la cartola; las máscaras de tarjeta
  (`****`, `XXXX`, `••••`) se buscan en los primeros 6.000 caracteres. También puedes asignarlos escribiendo `la FAN termina en 6958`
  o `la cuenta de la falabella termina en 1234`: el bot muestra la cuenta que entendió y pide confirmar con botones antes de guardar
  (sin "cuenta" ni "tarjeta" en el texto, decide por el tipo de la cuenta; rechaza dígitos que ya son de otra cuenta).
- **Varias cartolas seguidas:** los archivos de un álbum de Telegram, o con menos de 10 segundos entre sí, se agrupan en una cola
  por chat. Se analiza cada uno, se descartan los duplicados (mismo hash) y se muestra un solo resumen con una línea por archivo
  (formato o banco, fechas, movimientos y totales). Con *Importar todo* se usa la cuenta sugerida según el contenido (por ejemplo
  Falabella) y se pregunta solo por los que no tienen sugerencia; con *Revisar uno por uno* ves cada archivo (con vista previa si
  es PDF). Las preguntas de cuotas se hacen al final, todas juntas.
- **Cuenta:** el gasto usa la cuenta que mencionas (por ejemplo "débito"); si no mencionas ninguna, la última cuenta con que
  registraste un gasto a mano, y si no hay, la cuenta activa más antigua. No se pregunta antes: el botón *Cambiar cuenta* de la
  confirmación permite corregirla.
- **Foto con texto:** una foto con un texto que es un gasto (`almuerzo 5500`) se registra como gasto normal y la foto queda como su
  respaldo; con un pago de cuota, como respaldo de esa cuota.
- **Límite de Gemini:** máximo 30 llamadas por hora por chat, contadas en memoria (se reinician al reiniciar el servidor). Al pasarlo,
  el bot responde que no entendió y muestra ejemplos; los gastos con monto siguen funcionando solo con las reglas.
- El menú `/` de Telegram solo muestra `/help`, `/plan`, `/cuotas`, `/status` y `/update`; el resto de los comandos funciona igual si los escribes.

### Eliminar o corregir un registro respondiéndole

Responde (reply de Telegram) al mensaje que creó un registro: tu mensaje original o la confirmación del bot. Sirve para gastos e
ingresos, pagos de cuota, compras en cuotas, cuentas e importaciones de cartola.

| Dices | Qué pasa |
| --- | --- |
| `elimina esto`, `bórralo`, `me equivoqué, sácalo` | Muestra el registro y pide confirmar con **Eliminar** / **Cancelar** |
| `eran 4500`, `4.500`, `eran 57 mil` | Corrige el monto |
| `era con la falabella`, `con la FAN` | Cambia la cuenta (por nombre, banco o tipo; si calzan varias, te lo dice) |
| `la categoría es comida`, `era de comida` | Cambia la categoría |
| `fue ayer`, `fue el 15`, `15/11`, `fue el lunes` | Cambia la fecha |
| `deshacer` (respondiendo a la confirmación de una eliminación o corrección) | Lo recupera, hasta 24 horas después |
| `elimina el último gasto` (sin responder a nada) | Actúa sobre el último registro creado a mano en ese chat, con la misma confirmación |

- Una corrección entendida por reglas (monto, fecha, cuenta, categoría o lugar) **se aplica directo**, queda en `historial_cambios` y responde
  `Corregido: 5.000 → 4.690` con un botón **Deshacer** (o responde «deshacer» a ese mensaje, hasta 24 horas). Funciona respondiendo a tu
  mensaje o a la confirmación del bot, también cuando el gasto era aproximado ("como 5 mil"). Se entienden muletillas ("en realidad", "creo que",
  "perdón", "aprox", "como") y `era en el líder` cambia la descripción si «líder» no es una cuenta ni una categoría. Los montos nunca pasan por
  Gemini. Si el monto cambia más de 20 veces (por ejemplo "4690 lucas" = 4.690.000), pide confirmar con **Guardar** / **Cancelar**; lo que
  interpreta Gemini en las demás correcciones también pide confirmar. Solo se corrigen movimientos y pagos de cuota.
- Qué se elimina: un movimiento se borra junto con su comprobante (queda 24 h en `tmp/` por si lo deshaces); un pago de cuota se anula y la
  cuota vuelve a quedar pendiente; una compra en cuotas se desactiva (sus pagos se conservan); una cuenta con movimientos solo se
  desactiva, sin movimientos se elimina; una importación borra todos sus movimientos y el registro del archivo, así que puedes volver a
  importarlo.
- Las reglas entienden las frases de arriba; si no alcanzan, se consulta a Gemini (con el mismo límite por chat y sin enviar nada
  sensible). Si el mensaje no se entiende, el bot lo trata como un mensaje normal.
- Los vínculos mensaje-registro están en la tabla `mensajes_registro` y cada eliminación o corrección queda en `historial_cambios`
  (se crean solas al arrancar). Los registros anteriores a esta función no tienen mensaje asociado: se pueden eliminar con
  `/ultimos` o la web, no respondiéndoles.

### Empezar de cero: /reset y restaurar un respaldo

Solo para los chats de `TELEGRAM_ALLOWED_CHAT_IDS`. `/reset` no aparece en el menú `/`; también funciona escribiendo "empezar de cero"
o "borrar todo".

1. El bot muestra lo que hay (movimientos, cuentas, cuotas, plan de ahorro, gastos fijos, datos de transferencia, reglas, categorías
   personalizadas y archivos en storage) y ofrece tres botones:
   - **Borrar movimientos y archivos:** borra movimientos, pagos de préstamos, importaciones de cartolas, los vínculos mensaje-registro,
     el historial de cambios y los archivos de `cartolas/`, `comprobantes/` y `archivos/`. Mantiene cuentas, datos de transferencia,
     plan, cuotas (con su contador de cuotas pagadas) y categorías.
   - **Borrar todo:** además borra cuentas, cuotas, plan (vuelve a 50/30/20 sin ingreso), gastos fijos, datos de transferencia, reglas y
     categorías, y vuelve a crear las categorías base y la cuenta Efectivo. El usuario de la web no se toca.
   - **Cancelar.**
2. **Segunda confirmación:** hay que escribir exactamente `BORRAR TODO` (o `BORRAR MOVIMIENTOS`, según el botón) en 2 minutos.
   Cualquier otro texto cancela.
3. **Respaldo automático antes de borrar**, en `<FINANZAS_STORAGE>/respaldos/reset-AAAA-MM-DD_HHMMSS/` (hora de Chile):
   la BD (SQLite: copia de `finanzas.db` con la API de respaldo; MariaDB: `mysqldump` con un archivo de opciones temporal de permisos
   600, sin la contraseña en los argumentos) y `storage.tar.gz` con los archivos (sin `respaldos/` ni `tmp/`). Si el respaldo falla,
   no se borra nada. El reset nunca borra `respaldos/`. Requiere `tar` (y `mysqldump` si usas MariaDB) en el PATH del proceso.
4. El borrado de la BD es una sola transacción (hijos antes que padres), reinicia los autoincrementos y deja una fila `reset` en
   `historial_cambios`. Al terminar, el bot resume lo borrado y la ruta relativa del respaldo.

**Restaurar:** escribe "restaurar último respaldo". Muestra qué respaldo es y pide la misma doble confirmación (botón y luego
`RESTAURAR RESPALDO`). Antes de restaurar hace otro respaldo del estado actual (`respaldos/antes-de-restaurar-...`). Con MariaDB
necesita el cliente `mysql` en el PATH.

### Transferencias salientes

Una transferencia a otra persona no es siempre un gasto. Al registrarla por texto ("transferí 50 mil a Camila") o al importar una cartola
(cargos "TRANSFERENCIA A ..."), el bot la clasifica:

- **A una cuenta propia** (tu nombre o el de una de tus cuentas): movimiento interno (`transferencia_propia`): no suma como gasto ni como ingreso.
- **A quien le pagas una compra en cuotas** (por ejemplo Valeska): pago de cuotas. Cruza el monto con la cuota del mes de ese titular (la
  siguiente de cada compra en curso). Hay varias compras con la misma persona, así que cruza con **todas** sus cuotas del mes:
  - calza con **una cuota**: la vincula y avanza su contador;
  - calza con la **suma de varias o de todas**: reparte la transferencia en un movimiento por cuota (el total no cambia) y avanza el contador de cada compra;
  - **no calza sola, pero con otras transferencias del mismo mes a esa persona sí** (por ejemplo dos de $65.000 que juntas pagan $130.000): ofrece
    vincularlas todas; cada cuota avanza su contador y no se crea ningún movimiento nuevo;
  - es **parcial** o **sobra** plata: muestra la diferencia y deja **marcar con un botón por cuota** cuáles cubre (lo que sobra o falta queda en la
    última que marques).
  Siempre con botones; nada se vincula solo. El gasto sigue siendo la transferencia.
- **A cualquier otra persona:** pregunta si fue **gasto**, **préstamo** (queda anotado a esa persona) o **pago**, y **recuerda la respuesta por
  destinatario** (tabla `destinatarios_transferencia`, por nombre sin tildes ni mayúsculas): la próxima vez la aplica sin preguntar. Pregunta
  como máximo por 5 transferencias en cada importación. Nunca se guarda un RUT ni un número de cuenta: del destinatario solo queda el nombre.

En `/cuotas` y en `/cuentas` aparece, **por titular**, lo del mes: cuotas del mes (la cuota de cada compra en curso), lo pagado este mes
(movimientos ligados a esas compras) y lo pendiente (por compra, sin que lo que sobra en una tape lo que falta en otra).

### Compra en cuotas con la tarjeta de otra persona (cartola + comprobante)

Caso: pagas un Mac en 12 cuotas con la tarjeta de crédito de la tía Valeska y le transfieres cada mes. Puedes mandar juntos, sin comandos, la
**cartola de su tarjeta** (PDF, CSV o Excel) y la **captura del comprobante** de tu transferencia:

1. **La cartola se asocia a la cuenta de Valeska** (titular Valeska) por los 4 dígitos o el banco, como cualquier cartola. Si no existe una
   cuenta así pero la cartola trae la cuota de una compra en cuotas, pregunta si la creas como tarjeta de crédito con titular Valeska
   (botones: crear, "es mía" o cancelar).
2. **Reconoce la cuota** en la cartola: por el número ("06/12", "6/12", "C06/12", "CUOTA 6 DE 12", "6 de 12 cuotas"), por la descripción (alias de
   la compra) o por el monto; hace falta el número o dos de las otras señales. **Sincroniza el contador con la cartola**: si la app dice 5/12 y la
   cartola 06/12, al registrar tu transferencia pasa a 6/12. Si la cartola muestra un número menor o salta más de una cuota, avisa y **pregunta
   antes de cambiar** (usar el número de la cartola o dejarlo como está). Una cuota que ya estaba registrada **no se duplica**. Al llegar al total,
   la compra queda terminada y el resumen lo avisa.
3. **Los demás cargos no se guardan solos.** Son de Valeska por defecto. El bot los lista **en un solo mensaje** y preguntas cuáles son tuyos:
   toca los números (o "Ninguno es mío") o responde al mensaje, por ejemplo «el 2 y el 5 son míos», «todos» o «ninguno». Solo los que marques
   se guardan como gastos tuyos, en la cuenta de esa tarjeta. **Los demás se ignoran** (no se guardan, así no cuentan en tus totales); la
   cartola queda registrada como importada para no volver a procesarla. Decisión: ignorarlos en vez de guardarlos "marcados como de Valeska",
   porque eso exigiría una columna nueva en `movimientos` y filtrarla en todos los totales.
   En la lista, los cargos que son una compra en cuotas muestran su número ("TV SAMSUNG 3/10 (cuota 3/10)"). Los que marques como tuyos y sean una
   compra en cuotas **crean o actualizan una cuota activa** (acreedor: el titular de la tarjeta, total, cuota actual como cuotas pagadas y monto por
   cuota), sin duplicar si ya existe una con el mismo total, monto y descripción parecida; el movimiento queda ligado a ella.
4. **El comprobante** se lee con **OCR local** (`tesseract.js` con los datos de español de `@tesseract.js-data/spa`, sin descargar nada y sin
   enviar la imagen a ningún servicio) y se registra como **el pago de la cuota** del mes (monto y fecha del comprobante), ligado a la
   compra y a la cuenta tuya de la que salió (la que muestre el comprobante por sus 4 dígitos; si no, tu cuenta por defecto). Ese pago es el
   **único** registro del gasto: el cargo de la cartola no se guarda aparte, así que no se cuenta dos veces. Siempre pide confirmar.
   El OCR de capturas de apps no es perfecto: si no puede leer algo, el bot lo dice y usa la fecha de hoy o te lo pregunta.
5. **Si el monto del comprobante no calza** con el de la cuota (o con el cargo de la cartola), avisa y pregunta con cuál lo registra.
6. **Resumen del lote** al final: cartola de quién, cuota N de 12 registrada, cuántos gastos tuyos se agregaron y si se registró el pago.

Si la persona tiene **varias compras en cuotas**, el monto del comprobante se cruza con todas sus cuotas del mes (una, la suma de varias o todas) con el
mismo flujo de botones de arriba, y cada cuota pagada avanza su propio contador; las compras en cuotas que marques como tuyas en la cartola se
reconocen y sincronizan una por una.

Si el comprobante llega antes que la cartola espera hasta 25 segundos (110 si ya llegó un archivo) para combinarlos; si manda solo el
comprobante, lo registra como pago de la siguiente cuota; si manda solo la cartola, al final ofrece registrar la cuota con el monto del
cargo. Una foto que no parece un comprobante de transferencia sigue el flujo de siempre. A Gemini no viaja nada de esto.

### Gastos fijos con una frase

Además de `/fijo`, puedes escribirlos como hablas (reglas locales, sin Gemini):

- `gasto fijo: 24 mil en telefonía, lo pago a Vivian`
- `fijo 15.990 netflix`
- `agrega gasto fijo de 350 mil arriendo, se lo pago a Don Pedro el 5 de cada mes`
- `pago fijo 24000 telefonía a Vivian`

El bot saca el **monto** (24 mil, 24.000, 24k), la **descripción**, **a quién se le paga** (opcional) y el **día del mes** (opcional). Muestra un resumen con
**Guardar** y **Cancelar**; si falta el monto o la descripción, lo pregunta. Si ya existe un gasto fijo con esa descripción, ofrece **actualizar su monto**
(y el día o el destinatario) en vez de duplicarlo. `/fijos` muestra el día y a quién se le paga.

- **Destinatario:** se guarda en `gastos_fijos.destinatario`; si ya existe en `destinatarios_transferencia` (por nombre, sin tildes ni mayúsculas) también se
  guarda el enlace en `destinatario_id`. Se agregaron `gastos_fijos.destinatario`, `gastos_fijos.destinatario_id` y `movimientos.gasto_fijo_id` con una
  migración que se aplica sola al arrancar (SQLite y MariaDB) y están en `database/schema.sql`.
- **Pago del gasto fijo:** cuando sale una transferencia a ese destinatario por un monto parecido (±10 %) del gasto fijo, el bot propone con botones
  marcarla como ese pago (`movimientos.gasto_fijo_id`). Una transferencia marcada cuenta como gasto fijo en `/plan` y **no otra vez como gasto libre**.
  Si ese mes ya hay una marcada para ese gasto fijo, no vuelve a proponer. Si respondes **No**, no se deja como gasto sin más: sigue la pregunta de
  siempre (gasto, préstamo o pago), o se aplica lo que ya recordaba de ese destinatario.

### Guardar una cuenta o tarjeta con una frase

Además de `/savecard`, puedes escribirlo como hablas (siempre con los **últimos 4 dígitos**; reglas locales, sin Gemini):

- `guarda la tarjeta crédito 8263 es de Valeska Sanhueza`
- `agrega mi cuenta rut 1234 del banco estado`
- `nueva tarjeta débito 5555 de Juan`
- `la tarjeta 8263 es de Valeska`

El bot saca el tipo (crédito, débito, corriente, vista o rut), los 4 dígitos, el titular (si no lo dices, `TITULAR_POR_DEFECTO`) y el banco si aparece;
si viene un número largo guarda solo los últimos 4 y borra tu mensaje del chat. Es el mismo flujo de `/savecard`: muestra un resumen con **Guardar** y
**Cancelar**, y pregunta lo que falte (por ejemplo el tipo si dices solo "la tarjeta"). Si ya hay una cuenta con esos 4 dígitos, en vez de duplicarla ofrece
**actualizar su titular**. Una tarjeta de otra persona se nombra por su dueña ("Tarjeta de Valeska").

**El bot no se queda en silencio:** un mensaje que ninguna regla entiende (y que no va a Gemini, por ejemplo por traer datos sensibles) recibe "No entendí ese
mensaje" con botones (guardar una cuenta, registrar un gasto, ver gastos, plan, cuotas, cuentas, ayuda); un comando que no existe, un sticker, una nota de voz
o un error inesperado también reciben respuesta (los errores quedan en el log, sin el texto del mensaje). Un comando que existe pero recibe argumentos que no
entiende (por ejemplo `/status algo`) responde "No entendí lo que escribiste después de /status" con cómo usarlo, y un botón que venció o ya no tiene
estado responde "Este botón ya expiró, vuelve a intentarlo" en vez de quedarse girando.

### Editar una cuenta o tarjeta: /editarcuenta

`/editarcuenta` (alias `/editartarjeta`; también `/editarcuenta 8263` para abrir una directo) lista tus cuentas con botones, cada una como
**nombre · tipo · ****1234 · titular**. Al elegir una muestra sus datos y un botón por campo: **Nombre**, **Tipo**, **Banco**, **Titular**, **Últimos 4
dígitos**, **Cuenta vinculada** (para tarjetas) y **Predeterminada**. Cada campo se edita **respondiendo con el valor nuevo** (o eligiendo una opción, en
Tipo y Predeterminada), con un resumen "antes → después" y botones **Guardar** y **Cancelar**. En `/cuentas`, cada cuenta tiene un botón **Editar**.

- **Validaciones:** los dígitos son exactamente 4 (un número largo se rechaza y se borra tu mensaje) y no pueden quedar dos cuentas activas con los mismos 4
  dígitos y el mismo tipo; el nombre no puede quedar vacío ni ser solo números.
- **Predeterminada:** la cuenta que se usa cuando no dices con qué pagaste; manda sobre "la última que usaste". Solo una a la vez
  (columna `cuentas.predeterminada`, con migración segura).
- **Con frases (reglas locales, sin Gemini):** `cambia el nombre de la 8263 a Crédito Valeska`, `la tarjeta 8263 es del banco de chile`,
  `edita la cuenta 8263`. Respondiendo a un mensaje de `/cuentas`: `cámbiale el nombre a X`, `cambia el nombre de la 2 a X`, `la 2 es del banco de chile`.
  Todo pasa por el mismo resumen con Guardar y Cancelar y las mismas validaciones.
- **Nombre automático:** al guardar con una frase o con `/savecard`, el nombre **nunca** es solo dígitos. Si no das uno, se arma "Crédito Valeska ****8263" o
  "Débito Juan ****5555" (tipo, primer nombre del titular y los 4 dígitos). Una migración renombra con ese formato las cuentas que ya tenían solo dígitos
  como nombre.

### Cuentas, vínculos y datos guardados: /cuentas

`/cuentas` (alias `/datosguardados`; también "qué cuentas tengo", "muéstrame mis cuentas" y "qué datos tienes guardados", siempre por reglas,
sin Gemini) muestra en un mensaje lo que la app tiene registrado. `/datos` y `/misdatos` **no cambian**: siguen siendo los datos de transferencia.

- **Por cada cuenta, un bloque:** titular, banco y tipo, "Tarjeta terminada en XXXX vinculada a la cuenta terminada en YYYY" (o "sin tarjeta
  vinculada" / "sin número de cuenta vinculado"), si es la cuenta por defecto y cuántos movimientos y cartolas tiene. Las desactivadas se
  nombran al final.
- **Avisos** (`Aviso:`) cuando falta el titular, falta el vínculo que le corresponde a ese tipo de cuenta, o hay datos que no se pueden mostrar.
- **Cuotas activas** (descripción, titular, cuota N de total, monto y próxima fecha), **titular por defecto** (`TITULAR_POR_DEFECTO`),
  **categorías en uso** (solo nombres) y **totales** de movimientos con el primero y el último por fecha.
- **Privacidad:** solo 4 últimos dígitos. Si en `cuentas.numero_cuenta` quedó un número completo guardado, no se muestra y la vista avisa en qué
  cuenta está; otros dígitos que no sean exactamente 4 tampoco se muestran. Un número de más de 4 dígitos escrito en una corrección se rechaza.
- **Sin datos:** "Todavía no tengo cuentas ni cuotas guardadas".
- **Corregir respondiendo al mensaje**, en lenguaje natural y con confirmación por botones: `esta es de Valeska`, `la 2 es de Valeska`,
  `la FAN es de Valeska`, `la tarjeta 1234 es de Valeska` o `la tarjeta 1234 es de la cuenta 5678` (completa el dato que falta en la cuenta
  que ya tiene el otro; si son dos cuentas distintas no las une). Solo se puede responder a los mensajes de `/cuentas` enviados desde el último
  reinicio y hasta 6 horas después.

### Estado de la app: /status

`/status` (o escribir "estado", "status" o "todo bien?") revisa cada parte y responde **en un solo mensaje**, por secciones, con ✅ lo
que funciona, ❌ lo que no (con el motivo en lenguaje simple) y "Aviso:" lo que conviene mirar pero no es un problema. La última línea
es "Todo en orden" o "Hay N problemas". Solo para los chats de `TELEGRAM_ALLOWED_CHAT_IDS`. Cada chequeo corre en paralelo con un
máximo de 8 segundos; si se pasa, esa sección sale como "No respondió".

| Sección | Qué revisa |
| --- | --- |
| Servidor | sistema operativo y versión, equipo, tiempo encendido (equipo y app), Node y `NODE_ENV`, memoria libre y disco de la partición del storage |
| App | versión (hash corto y título), rama, cambios locales sin commit y si el remoto tiene commits nuevos (`git fetch` con 6 s y `GIT_TERMINAL_PROMPT=0`; si el fetch falla es un Aviso, no un error) |
| Web | "Deshabilitada" o "Escuchando en 127.0.0.1:PUERTO"; error si la web está bloqueada, no escucha, escucha fuera de localhost o está habilitada con `SERVIR_FRONTEND=false` (expondría solo la API, sin pantalla) |
| PM2 | si corre bajo PM2 (variable `pm_id`), nombre y reinicios |
| Base de datos | motor, conexión, usuario conectado, nombre y versión (con SQLite, tamaño del archivo), tablas principales y conteo de movimientos, cuentas y cuotas activas |
| Gemini | si hay `GEMINI_API_KEY`, una llamada mínima con su latencia; si falla, el motivo (clave, cuota, red). **No cuenta para el límite de 30 por hora** |
| Telegram | `getMe` (usuario del bot) y si el menú de comandos está registrado |
| Storage | si la ruta es `FINANZAS_STORAGE` o la de por defecto, que exista, que se pueda escribir (archivo de prueba en `tmp/`) y tamaño total y por carpeta (con un tope de 5 s: si se pasa, muestra "más de X") |
| Herramientas | `git`, `node`, `npm`, `tar` y, con MariaDB, `mysqldump` y `mysql` en el PATH del proceso |
| Respaldos | el último respaldo en `storage/respaldos/` |
| Variables | solo los **nombres** de las requeridas que faltan (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS` y, con MariaDB, las `DB_*`) y de las opcionales sin definir; `SESSION_SECRET` es opcional (solo la usa la web) |

Nunca se imprimen secretos, valores de variables, contraseñas, tokens ni rutas de `.env`. **Al arrancar en producción** el servidor corre
el mismo chequeo (15 segundos después de iniciar el bot) y lo manda a los chats autorizados **solo si hay algún ❌**.

### Reiniciar y actualizar desde el bot

Solo para los chats de `TELEGRAM_ALLOWED_CHAT_IDS` y solo con `NODE_ENV=production` (en desarrollo se bloquean para no cerrar
`npm run dev`). Ambos piden confirmación con botones.

- **`/reboot`**: responde "Reiniciando...", escribe `tmp/reinicio.json` (en la raíz de `FINANZAS_STORAGE`) y termina el proceso
  1,5 segundos después; PM2 lo levanta de nuevo. Al arrancar, el bot avisa "Listo, volví a estar en línea" con la versión actual.
- **`/update`**: edita un solo mensaje con el avance (*Verificando*, *Descargando cambios*, *Instalando dependencias* si aplica,
  *Reiniciando*).
  1. **Verifica** que `git`, `node` y `npm` existan en el PATH del proceso (muestra sus versiones), que el remoto responda
     (`git ls-remote --heads origin`, 20 s de tiempo máximo y `GIT_TERMINAL_PROMPT=0`) y la rama actual. Si algo falla lo explica en
     simple ("PM2 no encuentra npm: revisa el PATH o nvm", "no hay acceso al repositorio: falta la deploy key") y no sigue.
  2. Ejecuta `git pull --ff-only` en la raíz del repositorio; si falla o hay conflictos, no reinicia y manda las últimas líneas del
     error (sin rutas del servidor ni nada de `.env`). Si no hubo cambios, avisa "Ya estaba al día. Reinicio igual" y reinicia de todos modos (sin prueba del cambio ni resumen).
  3. **Prueba del cambio:** rama, hash anterior y nuevo, fecha (hora de Chile) y autor del último commit y total de archivos
     cambiados (`git diff --stat`).
  4. Si cambió `package.json` o `package-lock.json`, ejecuta `npm ci --omit=dev` (si falla, no reinicia).
  5. **Resumen con IA:** a Gemini solo viajan los títulos de los commits nuevos (hasta 30, sin los que parezcan traer datos
     sensibles) y los nombres de los archivos cambiados, nunca su contenido ni el diff. Devuelve 3 a 6 viñetas en español. Sin
     clave o con error, se muestran los títulos tal cual.
  6. Guarda en `tmp/reinicio.json` el hash esperado y reinicia como `/reboot`. Al volver, el mensaje "Listo, volví a estar en línea"
     incluye la versión y dice "Actualización confirmada" si coincide con el hash esperado, o "Algo no calzó" si no.
  - **`update.sh`:** hace todo de punta a punta con un solo comando (`bash update.sh`, desde cualquier carpeta; `/update` lo usa en vez de
    hacer el pull y el npm por su cuenta). En orden, con `set -Eeuo pipefail` (si algo falla, dice en qué paso):
    1. Se ubica en la carpeta del propio script.
    2. Verifica `git`, `node`, `npm`, `pm2`, `tar` (y `mysqldump` y `mysql` con MariaDB) y que exista el `.env` en la raíz, sin leer su
       contenido salvo la línea `DB_ENGINE=`; además la rama y que el remoto responda.
    3. `git pull --ff-only` mostrando el hash anterior y el nuevo.
    4. `npm ci --omit=dev` (o `npm install --omit=dev` si no hay `package-lock.json`) si cambió `package.json` o `package-lock.json`, o si
       falta `node_modules`.
    5. Migraciones: no hay un paso aparte; las tablas se crean y actualizan solas cuando arranca la app.
    6. **Siempre** inicia o reinicia con `pm2 startOrReload ecosystem.config.cjs --update-env` y `pm2 save`, aunque no haya cambios en git (así
       sirve también para el primer arranque).
    7. Espera unos segundos (`ESPERA_PM2`, 5 por defecto), comprueba con PM2 que el proceso esté `online` y que no haya reinicios en bucle
       (compara el contador antes y después) y lee los logs de ese arranque para confirmar que el bot inició. Si no está online, el
       bot quedó deshabilitado o hay reinicios en bucle, imprime las últimas 40 líneas de `pm2 logs <nombre> --lines 40 --nostream` y sale
       con código distinto de 0.
    8. Resumen final: hash, si instaló dependencias, estado de PM2 y "Bot en línea" (o el error).

    El nombre del proceso lo toma de `ecosystem.config.cjs` (`finanzas-personales`). El ecosistema fija `cwd` en la carpeta de la app, así que
    el `.env` de la raíz se carga aunque PM2 se lance desde otra carpeta, y `log_date_format` fijo para poder leer solo los logs del último arranque.

    El bot lo llama en dos partes (`--sin-reinicio` al comienzo y `--solo-reiniciar` al final) para poder mandar antes la prueba del cambio y
    el resumen con IA. Como PM2 mata al bot y a sus procesos hijos al recargar, la segunda parte se lanza desacoplada (`nohup`, en segundo
    plano) y su salida completa queda en `tmp/update-reinicio.log` (dentro de storage): si el bot no vuelve, ahí está el motivo. Si PM2
    no reinicia al bot en 40 segundos, el bot se cierra solo y PM2 lo levanta (autorestart). Sin cambios en git, `/update` dice
    "Ya estaba al día. Reinicio igual" y también reinicia, igual que `bash update.sh` a mano (sirve para levantar un bot que quedó mal o recargar el
    `.env`); al volver dice "Sin cambios en el código: reinicio completado".
  - **Motor de BD en el script:** `update.sh` toma `DB_ENGINE` del entorno; si no está, lee solo esa línea del `.env` de la raíz (sin cargar
    el archivo ni mostrar otras variables); si tampoco está, asume `sqlite` y avisa "DB_ENGINE no definido en .env, se asume sqlite".
    Imprime de dónde salió: `(entorno)`, `(.env)` o `(por defecto)`. Con `mariadb` revisa que existan `mysqldump` y `mysql`.
  - La llamada a Gemini del resumen de `/update` no cuenta para el límite de 30 por hora por chat.

Los comandos del sistema se ejecutan con `execFile` (sin shell) y con tiempo máximo, y ningún argumento viene de texto escrito por
el usuario. El usuario que corre PM2 necesita permiso para `git pull` (con credenciales sin contraseña, por ejemplo una deploy key)
y para escribir en el repositorio y en `node_modules`.

### Seguridad

- El bot **solo responde a los chat IDs autorizados** configurados en `.env`
- Cualquier otro usuario que intente usar el bot recibirá un mensaje de "No autorizado"
- El comando `/miid` es el único disponible para usuarios no autorizados (para que puedas obtener tu chat ID)
- El bot usa **long polling** (no webhook), por lo que no necesitas exponer puertos ni configurar HTTPS

### Solución de Problemas

**El bot no responde**:
```bash
# Ver logs
pm2 logs finanzas-personales

# Verificar que el token esté configurado
grep TELEGRAM_BOT_TOKEN .env

# Reiniciar
pm2 restart finanzas-personales
```

**"No estás autorizado"**:
- Envía `/miid` al bot para obtener tu chat ID
- Verifica que ese ID esté en `TELEGRAM_ALLOWED_CHAT_IDS` en `.env`
- Reinicia el servidor después de modificar `.env`

**El bot no detecta correctamente los montos o fechas**:
- Revisa los ejemplos de formato en `/ayuda`
- Asegúrate de incluir el monto en el mensaje
- Las fechas son opcionales (por defecto usa "hoy")

## 🔄 Actualizaciones

```bash
# En el servidor
cd /ruta/a/finanzas-personales
git pull
npm install
cd client && npm install && npm run build && cd ..
pm2 restart finanzas-personales
```

## 📞 Notas Importantes

- **Base de datos exclusiva**: `finanzas_personales_juan` - No compartir con otras aplicaciones
- **Usuario de BD exclusivo**: `finanzas_juan` - Permisos solo en su BD
- **Puerto**: 3005 - Ajustar si hay conflicto
- **Archivos**: Configurar rutas del NAS en `.env` antes de usar en producción
- **Backup**: Respaldar la base de datos periódicamente con `mysqldump`

## 🗄️ Backup de Base de Datos

```bash
# Crear backup
mysqldump -u finanzas_juan -p finanzas_personales_juan > backup_finanzas_$(date +%Y%m%d).sql

# Restaurar backup
mysql -u finanzas_juan -p finanzas_personales_juan < backup_finanzas_20241116.sql
```

## 📄 Licencia

Aplicación de uso personal. Todos los derechos reservados.
