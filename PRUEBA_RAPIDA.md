# Prueba Rápida de la Aplicación

## ⚡ Inicio Rápido

La aplicación ya está corriendo en: **http://localhost:3005**

### 1. Acceder a la Aplicación

Abre en tu navegador: http://localhost:3005

### 2. Iniciar Sesión

```
Email: juan@finanzas.cl
Contraseña: demo123
```

### 3. Explorar

Ya hay datos de prueba cargados:
- ✅ 2 cuentas (Banco de Chile y CMR Falabella)
- ✅ 10 movimientos de ejemplo
- ✅ 1 préstamo registrado
- ✅ Gráficos con datos reales

## 🧪 Probar Funcionalidades

### Importar una Cartola

1. Ir a **Importar** en el menú
2. Seleccionar cuenta: "Cuenta FAN Banco de Chile"
3. Subir el archivo: `ejemplo_cartola.csv`
4. Revisar la vista previa
5. Clic en **Confirmar e Importar**
6. Ir a **Movimientos** para ver los nuevos registros

### Agregar un Movimiento Manual

1. Ir a **Movimientos**
2. Clic en **Nuevo Movimiento**
3. Llenar el formulario:
   - Cuenta: CMR Mastercard Falabella
   - Fecha: Hoy
   - Descripción: Compra Supermercado
   - Monto: 25000
   - Tipo: Cargo
   - Categoría: Supermercado
4. Guardar

### Registrar un Préstamo

1. En **Movimientos**, crear uno nuevo
2. Marcar checkbox "Es préstamo / tarjeta prestada"
3. Ingresar nombre de persona: Pedro
4. Guardar
5. Ir a **Préstamos** para ver el saldo

### Crear una Categoría

1. Ir a **Categorías**
2. Clic en **Nueva**
3. Nombre: Mascotas
4. Elegir color e icono
5. Guardar

### Crear Regla de Autocategorización

1. En **Categorías**, sección "Reglas"
2. Clic en **Nueva Regla**
3. Texto a buscar: uber
4. Categoría: Transporte
5. Guardar
6. Al importar movimientos con "uber", se categorizarán automáticamente

## 📊 Panel Principal

El **Dashboard** muestra:
- Resumen del mes (ingresos, gastos, saldo)
- Gráfico circular de gastos por categoría
- Evolución de últimos meses
- Estado de tarjetas de crédito con cupo usado
- Deudas pendientes

## 🔄 Reiniciar Servidor (si es necesario)

```bash
# Detener
pm2 stop finanzas-personales

# Iniciar
pm2 start ecosystem.config.cjs

# Ver logs
pm2 logs finanzas-personales
```

## 🗄️ Base de Datos

La aplicación usa SQLite en desarrollo (archivo `finanzas.db`).

Para agregar más datos de prueba:
```bash
node seed-data.mjs
```

## 🐛 Verificar que Funciona

### Verificar Backend
```bash
curl http://localhost:3005/api/auth/me
# Debe responder: {"error":"No autenticado"}
```

### Verificar Frontend
```bash
curl http://localhost:3005/
# Debe devolver el HTML de la aplicación
```

## 📱 Vista Móvil

La aplicación es responsive. Para probar en móvil:
1. Abrir DevTools en el navegador (F12)
2. Activar vista de dispositivo móvil
3. La interfaz se adapta automáticamente

## 🎯 Formatos Soportados para Importación

- **CSV**: Banco de Chile, Banco Falabella, formato genérico
- **Excel** (.xlsx, .xls): Mismo formato que CSV
- **PDF**: Extracción básica de texto (puede requerir revisión)

## ⚙️ Cambiar a MariaDB en Producción

1. Editar `server/db.js`:
   ```javascript
   const USE_SQLITE = false; // Cambiar a false
   ```

2. Configurar `.env`:
   ```
   DB_HOST=localhost
   DB_USER=finanzas_juan
   DB_PASSWORD=tu_contraseña
   DB_NAME=finanzas_personales_juan
   ```

3. Crear la base de datos:
   ```bash
   mysql -u root -p < database/schema.sql
   mysql -u root -p < database/crear_usuario.sql
   ```

4. Reiniciar servidor

## 📖 Documentación Completa

Ver archivos:
- `README.md` - Instalación completa para producción
- `RESUMEN_PROYECTO.md` - Resumen técnico del proyecto
- `.env.example` - Variables de configuración

## 💡 Notas

- La contraseña `demo123` debe cambiarse en producción
- Los archivos se guardan en `uploads/` (configurar NAS en producción)
- El puerto 3005 es configurable en `.env`
- La sesión expira en 24 horas

## ✅ Checklist de Verificación

- [ ] La página http://localhost:3005 carga correctamente
- [ ] Puedo iniciar sesión con juan@finanzas.cl
- [ ] El dashboard muestra gráficos con datos
- [ ] Puedo navegar entre todas las secciones
- [ ] Puedo crear una cuenta nueva
- [ ] Puedo agregar un movimiento manual
- [ ] Puedo importar el archivo ejemplo_cartola.csv
- [ ] Los gráficos se actualizan con nuevos datos

Si todos los items están OK, ¡la aplicación está funcionando perfectamente! 🎉
