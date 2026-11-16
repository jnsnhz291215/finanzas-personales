import Database from 'better-sqlite3';

const db = new Database('./finanzas.db');

console.log('Agregando datos de prueba...');

// Agregar una cuenta
const insertCuenta = db.prepare(`
  INSERT INTO cuentas (nombre, tipo, banco, cupo_total, dia_facturacion, dia_vencimiento, activa)
  VALUES (?, ?, ?, ?, ?, ?, 1)
`);

const cuentaId = insertCuenta.run(
  'Cuenta FAN Banco de Chile',
  'cuenta_vista',
  'Banco de Chile',
  null,
  null,
  null
).lastInsertRowid;

console.log('✓ Cuenta creada con ID:', cuentaId);

// Agregar tarjeta de crédito
const tarjetaId = insertCuenta.run(
  'CMR Mastercard Falabella',
  'tarjeta_credito',
  'Banco Falabella',
  500000,
  15,
  5
).lastInsertRowid;

console.log('✓ Tarjeta creada con ID:', tarjetaId);

// Obtener categorías
const categorias = db.prepare('SELECT * FROM categorias').all();
const catSupermercado = categorias.find(c => c.nombre === 'Supermercado');
const catTransporte = categorias.find(c => c.nombre === 'Transporte');
const catComida = categorias.find(c => c.nombre === 'Comida');
const catSuscripciones = categorias.find(c => c.nombre === 'Suscripciones');
const catIngresos = categorias.find(c => c.nombre === 'Ingresos');

// Agregar movimientos
const insertMov = db.prepare(`
  INSERT INTO movimientos (cuenta_id, fecha, descripcion, monto, tipo, categoria_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const movimientos = [
  [cuentaId, '2024-11-01', 'Sueldo noviembre', 1200000, 'abono', catIngresos.id],
  [cuentaId, '2024-11-05', 'Supermercado Jumbo', 45000, 'cargo', catSupermercado.id],
  [tarjetaId, '2024-11-06', 'Uber viaje centro', 8500, 'cargo', catTransporte.id],
  [tarjetaId, '2024-11-07', 'Netflix suscripción', 7990, 'cargo', catSuscripciones.id],
  [tarjetaId, '2024-11-08', 'Comida Pedidos Ya', 18000, 'cargo', catComida.id],
  [cuentaId, '2024-11-10', 'Supermercado Líder', 38000, 'cargo', catSupermercado.id],
  [tarjetaId, '2024-11-12', 'Café Juan Valdez', 4500, 'cargo', catComida.id],
  [cuentaId, '2024-11-14', 'Pago luz', 28000, 'cargo', null],
  [tarjetaId, '2024-11-15', 'Bencina Copec', 40000, 'cargo', catTransporte.id]
];

for (const mov of movimientos) {
  insertMov.run(...mov);
}

console.log(`✓ ${movimientos.length} movimientos agregados`);

// Agregar un préstamo
const movPrestamo = db.prepare(`
  INSERT INTO movimientos (cuenta_id, fecha, descripcion, monto, tipo, es_prestamo, persona_prestamo, categoria_id)
  VALUES (?, ?, ?, ?, ?, 1, ?, ?)
`);

movPrestamo.run(tarjetaId, '2024-11-10', 'Compra para María', 25000, 'cargo', 'María', catComida.id);
console.log('✓ Préstamo agregado');

db.close();
console.log('\n✓ Datos de prueba agregados exitosamente');
