# Bot de Telegram - Finanzas Personales

Bot de Telegram para registrar gastos e ingresos usando lenguaje natural en español chileno.

## Arquitectura

```
server/telegram/
├── bot.js           # Lógica principal del bot (comandos, handlers)
├── parser.js        # Parser de lenguaje natural
├── parser.test.js   # Tests unitarios del parser
└── README.md        # Este archivo
```

## Componentes Principales

### `bot.js`
- Inicialización del bot con long polling
- Manejo de comandos (`/start`, `/ayuda`, `/resumen`, etc.)
- Manejo de mensajes de texto (registro de transacciones)
- Manejo de archivos (cartolas, fotos)
- Callbacks de botones inline (confirmar/cancelar)

### `parser.js`
- `extraerMonto()` - Detecta montos en múltiples formatos
- `extraerFecha()` - Detecta fechas relativas y absolutas
- `extraerMedioPago()` - Identifica medio de pago
- `detectarTipo()` - Determina si es cargo o abono
- `detectarCategoria()` - Categorización automática por palabras clave
- `extraerDescripcion()` - Limpia y extrae descripción
- `parsearMensaje()` - Función principal que combina todo

## Flujo de Registro de Transacción

1. Usuario envía mensaje de texto
2. `bot.on('message')` recibe el mensaje
3. Verifica que el chat esté autorizado
4. Llama a `parsearMensaje()` para extraer información
5. Busca cuenta y categoría en la BD
6. Crea transacción temporal en `pendingTransactions`
7. Muestra resumen con botones inline
8. Usuario confirma o cancela
9. `bot.on('callback_query')` maneja la respuesta
10. Si confirma, guarda en BD usando `guardarMovimiento()`

## Formatos Soportados

### Montos
```javascript
// Con puntos (formato chileno)
"12.500"    → 12500
"$25.000"   → 25000

// Sin formato
"12500"     → 12500
"5000"      → 5000

// Lucas
"5 lucas"   → 5000
"2.5 lucas" → 2500

// Formato k
"5k"        → 5000
```

### Fechas
```javascript
// Relativas
"hoy"       → fecha actual
"ayer"      → un día antes
"anteayer"  → dos días antes

// Días de semana
"lunes"     → último lunes pasado
"martes"    → último martes pasado

// Formato numérico
"15/11"     → 15 de noviembre del año actual
"15-11"     → 15 de noviembre del año actual
```

### Medios de Pago
```javascript
// Detecta palabras clave
"débito", "debito"           → débito
"crédito", "credito"         → crédito
"CMR", "falabella"           → CMR
"efectivo", "cash"           → efectivo
"transferencia", "transf"    → transferencia
```

### Categorías
```javascript
// Palabras clave → Categoría
"super", "jumbo"             → Supermercado
"uber", "metro"              → Transporte
"comida", "restaurant"       → Comida
"sueldo", "salario"          → Sueldo
// etc.
```

## Seguridad

### Control de Acceso
- Solo responde a chat IDs en `TELEGRAM_ALLOWED_CHAT_IDS`
- Verifica autorización en cada mensaje/comando
- `/miid` es el único comando disponible sin autorización

### Manejo de Errores
- Try-catch en todos los handlers
- Mensajes de error amigables al usuario
- Logs de errores en consola del servidor

### Datos Temporales
- Transacciones pendientes se guardan en `Map` en memoria
- Se eliminan automáticamente después de 5 minutos
- No persisten entre reinicios del servidor

## Extensibilidad

### Agregar Nuevo Comando

```javascript
bot.onText(/\/micomando/, async (msg) => {
  const chatId = msg.chat.id;
  
  if (!esChatAutorizado(chatId)) {
    await bot.sendMessage(chatId, '❌ No autorizado');
    return;
  }
  
  // Lógica del comando
  await bot.sendMessage(chatId, 'Respuesta');
});
```

### Agregar Nueva Categoría

En `parser.js`, editar `CATEGORIAS_KEYWORDS`:

```javascript
const CATEGORIAS_KEYWORDS = {
  // ... existentes ...
  'MiCategoria': ['palabra1', 'palabra2', 'palabra3']
};
```

### Agregar Nuevo Medio de Pago

En `parser.js`, editar `MEDIOS_PAGO`:

```javascript
const MEDIOS_PAGO = {
  // ... existentes ...
  'MiTarjeta': ['palabra1', 'palabra2']
};
```

## Testing

### Correr Tests
```bash
npm test                    # Todos los tests
npm run test:telegram       # Solo tests del parser
```

### Agregar Nuevos Tests

En `parser.test.js`:

```javascript
describe('Mi Nueva Funcionalidad', () => {
  test('debería hacer X', () => {
    expect(miFuncion('entrada')).toBe('esperado');
  });
});
```

## Troubleshooting

### Bot no responde
1. Verificar que el token esté configurado en `.env`
2. Verificar que el chat ID esté en `TELEGRAM_ALLOWED_CHAT_IDS`
3. Revisar logs del servidor: `pm2 logs finanzas-personales`
4. Verificar que no haya errores de rate limiting en Telegram API

### Parser no detecta montos
1. Verificar que el monto tenga al menos 4 dígitos o use "lucas"/"k"
2. Revisar regex `MONTO_REGEX` en `parser.js`
3. Agregar test case que falle y corregir regex

### Fechas incorrectas
1. Verificar que "anteayer" se detecte antes que "ayer"
2. Revisar orden de detección en `extraerFecha()`
3. Considerar zona horaria del servidor

### No se guarda en BD
1. Verificar que exista al menos una cuenta
2. Verificar logs de error en consola
3. Revisar función `guardarMovimiento()`

## Mejoras Futuras

- [ ] Editar transacciones desde el bot
- [ ] Importación completa de cartolas (no solo guardar archivo)
- [ ] Consultas por rango de fechas
- [ ] Exportar resumen mensual como PDF
- [ ] Notificaciones de vencimientos de tarjetas
- [ ] Soporte para múltiples usuarios
- [ ] Cache de cuentas/categorías para mejor performance
- [ ] Validación más robusta de permisos por usuario
