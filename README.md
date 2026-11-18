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

# Ejecutar el script de creación
source database/schema.sql

# Crear el usuario y permisos (editar la contraseña antes)
source database/crear_usuario.sql
# O ejecutar manualmente:
# CREATE USER 'finanzas_juan'@'localhost' IDENTIFIED BY 'tu_contraseña_segura';
# GRANT ALL PRIVILEGES ON finanzas_personales_juan.* TO 'finanzas_juan'@'localhost';
# FLUSH PRIVILEGES;

# Salir
exit
```

### 3. Configurar Rutas de Almacenamiento

```bash
# Crear carpetas en el NAS o servidor (ajustar rutas según tu configuración)
mkdir -p /ruta/al/nas/finanzas-juan/uploads
mkdir -p /ruta/al/nas/finanzas-juan/cartolas
mkdir -p /ruta/al/nas/finanzas-juan/respaldos

# Dar permisos de escritura
chmod 755 /ruta/al/nas/finanzas-juan
chmod 755 /ruta/al/nas/finanzas-juan/uploads
chmod 755 /ruta/al/nas/finanzas-juan/cartolas
chmod 755 /ruta/al/nas/finanzas-juan/respaldos
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

# Base de Datos (usuario exclusivo, BD separada)
DB_HOST=localhost
DB_PORT=3306
DB_USER=finanzas_juan
DB_PASSWORD=tu_contraseña_segura
DB_NAME=finanzas_personales_juan

# Generar un secreto aleatorio largo
SESSION_SECRET=genera_uno_con_openssl_rand_base64_32

# Contraseña inicial (cambiarla después del primer login)
ADMIN_PASSWORD=cambiar123

# Rutas de almacenamiento (AJUSTAR A TU SERVIDOR/NAS)
UPLOADS_PATH=/ruta/al/nas/finanzas-juan/uploads
CARTOLAS_PATH=/ruta/al/nas/finanzas-juan/cartolas
RESPALDOS_PATH=/ruta/al/nas/finanzas-juan/respaldos
```

### 5. Instalar Dependencias

```bash
# Instalar dependencias del backend
npm install

# Instalar dependencias del frontend
cd client
npm install
cd ..
```

### 6. Compilar el Frontend

```bash
npm run build:client
```

### 7. Configurar PM2

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

### 8. Configurar Cloudflare Tunnel

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

### 9. Primer Acceso

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

- `/start` - Iniciar el bot y ver instrucciones
- `/ayuda` - Ver todos los comandos disponibles
- `/resumen` - Resumen del mes actual (ingresos, gastos, saldo)
- `/ultimos` - Ver los últimos 10 movimientos
- `/borrar_ultimo` - Eliminar el último movimiento (con confirmación)
- `/miid` - Obtener tu chat ID

#### Importar Cartolas

Envía directamente un archivo de cartola (CSV, Excel o PDF) al bot. El archivo se guardará en el servidor y podrás importarlo desde la aplicación web.

#### Enviar Respaldos

Envía fotos de boletas o comprobantes. Se guardarán en la carpeta de uploads del servidor.

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
