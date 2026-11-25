import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

let db;

export async function getConnection() {
  if (!db) {
    db = new Database(path.join(__dirname, '../finanzas.db'));
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export async function inicializarDB() {
  try {
    const database = await getConnection();
    
    // Crear tablas
    database.exec(`
      CREATE TABLE IF NOT EXISTS usuario (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cuentas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL CHECK(tipo IN ('cuenta_corriente', 'cuenta_vista', 'cuenta_ahorro', 'tarjeta_credito', 'tarjeta_debito', 'efectivo')),
        banco TEXT,
        numero_cuenta TEXT,
        cupo_total REAL,
        dia_facturacion INTEGER,
        dia_vencimiento INTEGER,
        activa INTEGER DEFAULT 1,
        notas TEXT,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#6B7280',
        icono TEXT DEFAULT 'fa-folder',
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS reglas_categoria (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        texto_buscar TEXT NOT NULL,
        categoria_id INTEGER NOT NULL,
        activa INTEGER DEFAULT 1,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS movimientos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cuenta_id INTEGER NOT NULL,
        fecha DATE NOT NULL,
        descripcion TEXT NOT NULL,
        monto REAL NOT NULL,
        tipo TEXT NOT NULL CHECK(tipo IN ('cargo', 'abono')),
        categoria_id INTEGER,
        persona_prestamo TEXT,
        es_prestamo INTEGER DEFAULT 0,
        notas TEXT,
        archivo_respaldo TEXT,
        importado_de TEXT,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE CASCADE,
        FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS pagos_prestamos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        persona TEXT NOT NULL,
        monto REAL NOT NULL,
        fecha DATE NOT NULL,
        notas TEXT,
        creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS archivos_importados (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre_archivo TEXT NOT NULL,
        hash_archivo TEXT NOT NULL,
        cuenta_id INTEGER,
        cantidad_movimientos INTEGER DEFAULT 0,
        fecha_importacion DATETIME DEFAULT CURRENT_TIMESTAMP,
        ruta_archivo TEXT,
        FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_movimientos_fecha ON movimientos(fecha);
      CREATE INDEX IF NOT EXISTS idx_movimientos_cuenta ON movimientos(cuenta_id);
      CREATE INDEX IF NOT EXISTS idx_movimientos_categoria ON movimientos(categoria_id);
      CREATE INDEX IF NOT EXISTS idx_movimientos_prestamo ON movimientos(es_prestamo, persona_prestamo);
      CREATE INDEX IF NOT EXISTS idx_prestamos_persona ON pagos_prestamos(persona);
      CREATE INDEX IF NOT EXISTS idx_archivos_hash ON archivos_importados(hash_archivo);
    `);

    // Migración: tipo_movimiento y cuenta_destino_id
    migrarTipoMovimiento(database);

    // Migración: ultimos4 y titular en cuentas
    migrarDatosCuenta(database);

    // Migración: tipo 'efectivo' en cuentas (reconstruye la tabla si el CHECK no lo incluye)
    migrarTipoEfectivo(database);

    // Migración: ultimos4_cuenta (últimos 4 del número de cuenta, distinto de ultimos4 de la tarjeta)
    migrarUltimos4Cuenta(database);

    // Migración: tabla datos_transferencia
    migrarDatosTransferencia(database);

    // Migración: plan de ahorro y gastos fijos
    migrarPlanAhorro(database);

    // Migración: compras en cuotas y su vínculo con movimientos
    migrarComprasCuotas(database);

    // Insertar categorías por defecto
    const categorias = [
      ['Supermercado', '#10B981', 'fa-shopping-cart'],
      ['Transporte', '#3B82F6', 'fa-bus'],
      ['Comida', '#F59E0B', 'fa-utensils'],
      ['Cuentas y Servicios', '#EF4444', 'fa-file-invoice-dollar'],
      ['Suscripciones', '#8B5CF6', 'fa-sync'],
      ['Salud', '#EC4899', 'fa-heartbeat'],
      ['Entretenimiento', '#14B8A6', 'fa-film'],
      ['Educación', '#6366F1', 'fa-graduation-cap'],
      ['Vivienda', '#F97316', 'fa-home'],
      ['Ingresos', '#22C55E', 'fa-arrow-down'],
      ['Otros', '#6B7280', 'fa-ellipsis-h']
    ];

    const insertCat = database.prepare('INSERT OR IGNORE INTO categorias (nombre, color, icono) VALUES (?, ?, ?)');
    for (const cat of categorias) {
      insertCat.run(cat);
    }

    // Verificar usuario
    const usuario = database.prepare('SELECT * FROM usuario LIMIT 1').get();
    
    if (!usuario) {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'demo123', 10);
      database.prepare('INSERT INTO usuario (nombre, email, password_hash) VALUES (?, ?, ?)').run(
        'Juan', 'juan@finanzas.cl', passwordHash
      );
      console.log('✓ Usuario administrador creado (email: juan@finanzas.cl)');
    }

    console.log('✓ Base de datos SQLite inicializada');
    return database;
  } catch (error) {
    console.error('Error al inicializar base de datos:', error.message);
    throw error;
  }
}

const TIPOS_CUENTA_SQL = "'cuenta_corriente', 'cuenta_vista', 'cuenta_ahorro', 'tarjeta_credito', 'tarjeta_debito', 'efectivo'";

// Columnas conocidas de cuentas (en el orden de la tabla reconstruida)
const COLUMNAS_CUENTAS = [
  'id', 'nombre', 'tipo', 'banco', 'numero_cuenta', 'cupo_total', 'dia_facturacion',
  'dia_vencimiento', 'activa', 'notas', 'creado_en', 'actualizado_en', 'ultimos4', 'titular', 'ultimos4_cuenta'
];

/**
 * Migración idempotente (SQLite): admite el tipo 'efectivo' en cuentas.
 *
 * SQLite no permite modificar un CHECK, así que se reconstruye la tabla con el procedimiento
 * oficial: foreign_keys=OFF (fuera de la transacción), crear cuentas_nueva, copiar todo,
 * borrar la vieja, renombrar, recrear índices y triggers, y foreign_key_check. Con las
 * llaves foráneas apagadas el DROP no dispara el borrado en cascada de movimientos.
 * Si algo falla: rollback, la tabla queda como estaba y se registra solo el código del error.
 */
function migrarTipoEfectivo(database) {
  const fila = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cuentas'").get();
  if (!fila || fila.sql.includes("'efectivo'")) return; // ya admite efectivo

  const columnasActuales = database.prepare('PRAGMA table_info(cuentas)').all().map(c => c.name);
  const desconocidas = columnasActuales.filter(c => !COLUMNAS_CUENTAS.includes(c));
  if (desconocidas.length > 0) {
    // No se reconstruye para no perder una columna que esta migración no conoce
    console.error('Migración de cuentas omitida: la tabla tiene columnas no previstas');
    return;
  }

  // Índices y triggers de cuentas (los índices automáticos no tienen sql y no se recrean)
  const objetos = database
    .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'cuentas' AND type IN ('index', 'trigger') AND sql IS NOT NULL")
    .all()
    .map(o => o.sql);

  const columnasCopia = COLUMNAS_CUENTAS.filter(c => columnasActuales.includes(c)).join(', ');

  // PRAGMA foreign_keys no se puede cambiar dentro de una transacción
  database.pragma('foreign_keys = OFF');
  try {
    if (database.pragma('foreign_keys', { simple: true }) !== 0) {
      throw new Error('no se pudo desactivar foreign_keys');
    }

    const reconstruir = database.transaction(() => {
      database.exec('DROP TABLE IF EXISTS cuentas_nueva');
      database.exec(`
        CREATE TABLE cuentas_nueva (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre TEXT NOT NULL,
          tipo TEXT NOT NULL CHECK(tipo IN (${TIPOS_CUENTA_SQL})),
          banco TEXT,
          numero_cuenta TEXT,
          cupo_total REAL,
          dia_facturacion INTEGER,
          dia_vencimiento INTEGER,
          activa INTEGER DEFAULT 1,
          notas TEXT,
          creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
          actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
          ultimos4 TEXT,
          titular TEXT,
          ultimos4_cuenta TEXT
        )
      `);
      database.exec(`INSERT INTO cuentas_nueva (${columnasCopia}) SELECT ${columnasCopia} FROM cuentas`);

      const antes = database.prepare('SELECT COUNT(*) AS n FROM cuentas').get().n;
      const despues = database.prepare('SELECT COUNT(*) AS n FROM cuentas_nueva').get().n;
      if (antes !== despues) throw new Error('la copia de cuentas quedó incompleta');

      database.exec('DROP TABLE cuentas');
      database.exec('ALTER TABLE cuentas_nueva RENAME TO cuentas');
      for (const sql of objetos) database.exec(sql);

      // Las llaves foráneas de movimientos, archivos_importados, etc. deben seguir válidas
      if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('foreign_key_check encontró referencias rotas');
      }
    });
    reconstruir();
    console.log("✓ Tabla cuentas actualizada: admite el tipo 'efectivo'");
  } catch (error) {
    // Rollback automático; solo el código o el nombre del error, sin datos
    console.error('Error al migrar cuentas (efectivo):', error.code ?? error.message);
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/**
 * Migración idempotente (SQLite): compras_cuotas (compras pagadas en cuotas a una persona o
 * tarjeta ajena) y, en movimientos, compra_cuota_id y numero_cuota para ligar cada pago.
 */
function migrarComprasCuotas(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS compras_cuotas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT NOT NULL,
      alias_cartola TEXT,
      acreedor TEXT NOT NULL,
      monto_total REAL,
      monto_cuota REAL NOT NULL,
      total_cuotas INTEGER NOT NULL,
      cuotas_pagadas INTEGER NOT NULL DEFAULT 0,
      fecha_inicio DATE,
      dia_pago INTEGER,
      terminada INTEGER NOT NULL DEFAULT 0,
      activa INTEGER NOT NULL DEFAULT 1,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_compras_cuotas_activa ON compras_cuotas(activa, terminada);
  `);

  const columnas = database.prepare('PRAGMA table_info(movimientos)').all().map(c => c.name);
  if (!columnas.includes('compra_cuota_id')) {
    database.exec('ALTER TABLE movimientos ADD COLUMN compra_cuota_id INTEGER REFERENCES compras_cuotas(id) ON DELETE SET NULL');
  }
  if (!columnas.includes('numero_cuota')) {
    database.exec('ALTER TABLE movimientos ADD COLUMN numero_cuota INTEGER');
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_movimientos_compra_cuota ON movimientos(compra_cuota_id)');
}

/**
 * Migración idempotente (SQLite): agrega ultimos4_cuenta a cuentas, los últimos 4 dígitos del
 * número de cuenta (ultimos4 es el de la tarjeta). Nunca se guardan números completos.
 */
function migrarUltimos4Cuenta(database) {
  const columnas = database.prepare('PRAGMA table_info(cuentas)').all().map(c => c.name);
  if (!columnas.includes('ultimos4_cuenta')) {
    database.exec('ALTER TABLE cuentas ADD COLUMN ultimos4_cuenta TEXT');
  }
}

/**
 * Migración idempotente (SQLite): plan_ahorro (una sola fila, id = 1) y gastos_fijos.
 * La suma de porcentajes (100) se valida en la API: un CHECK sobre REAL fallaría por
 * redondeo de decimales.
 */
function migrarPlanAhorro(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_ahorro (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ingreso_base REAL,
      pct_fijos REAL NOT NULL DEFAULT 50,
      pct_libres REAL NOT NULL DEFAULT 30,
      pct_ahorro REAL NOT NULL DEFAULT 20,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO plan_ahorro (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS gastos_fijos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      monto REAL NOT NULL,
      dia_pago INTEGER,
      categoria_id INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
      cuenta_id INTEGER REFERENCES cuentas(id) ON DELETE SET NULL,
      palabras_clave TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gastos_fijos_activo ON gastos_fijos(activo);
  `);

  // Bases que ya tenían gastos_fijos sin palabras_clave
  const columnas = database.prepare('PRAGMA table_info(gastos_fijos)').all().map(c => c.name);
  if (!columnas.includes('palabras_clave')) {
    database.exec('ALTER TABLE gastos_fijos ADD COLUMN palabras_clave TEXT');
  }
}

/**
 * Migración idempotente (SQLite): tabla datos_transferencia, con mis propios datos para que
 * me depositen. Va aparte de cuentas porque cuenta_id es opcional (puede haber datos de una
 * cuenta que no uso para movimientos) y porque la API de cuentas devuelve todas sus columnas.
 */
function migrarDatosTransferencia(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS datos_transferencia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cuenta_id INTEGER REFERENCES cuentas(id) ON DELETE SET NULL,
      alias TEXT NOT NULL,
      nombre_titular TEXT NOT NULL,
      rut TEXT NOT NULL,
      banco TEXT NOT NULL,
      tipo_cuenta TEXT NOT NULL CHECK(tipo_cuenta IN ('corriente', 'vista', 'rut', 'ahorro')),
      numero_cuenta TEXT NOT NULL,
      email TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en DATETIME DEFAULT CURRENT_TIMESTAMP,
      actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_datos_transferencia_banco_numero ON datos_transferencia(banco, numero_cuenta);
    CREATE INDEX IF NOT EXISTS idx_datos_transferencia_cuenta ON datos_transferencia(cuenta_id);
  `);
}

/**
 * Migración idempotente (SQLite): agrega ultimos4 (solo los 4 últimos dígitos de una
 * tarjeta o cuenta; nunca el número completo) y titular a cuentas.
 */
function migrarDatosCuenta(database) {
  const columnas = database.prepare('PRAGMA table_info(cuentas)').all().map(c => c.name);
  if (!columnas.includes('ultimos4')) {
    database.exec('ALTER TABLE cuentas ADD COLUMN ultimos4 TEXT');
  }
  if (!columnas.includes('titular')) {
    database.exec('ALTER TABLE cuentas ADD COLUMN titular TEXT');
  }
}

/**
 * Migración idempotente (SQLite): agrega tipo_movimiento y cuenta_destino_id a movimientos.
 * Registros existentes: abono -> ingreso, cargo -> compra.
 */
function migrarTipoMovimiento(database) {
  const migrar = database.transaction(() => {
    const columnas = database.prepare('PRAGMA table_info(movimientos)').all().map(c => c.name);

    if (!columnas.includes('tipo_movimiento')) {
      database.exec(`
        ALTER TABLE movimientos ADD COLUMN tipo_movimiento TEXT NOT NULL DEFAULT 'compra'
          CHECK(tipo_movimiento IN ('compra', 'pago_tarjeta', 'transferencia_propia', 'transferencia_terceros', 'ingreso', 'otro'))
      `);
    }

    if (!columnas.includes('cuenta_destino_id')) {
      database.exec('ALTER TABLE movimientos ADD COLUMN cuenta_destino_id INTEGER REFERENCES cuentas(id) ON DELETE SET NULL');
    }

    // Backfill y reparación: un abono clasificado como compra (por ejemplo, importado
    // por una ruta que aún no informa tipo_movimiento) pasa a ingreso
    database.exec("UPDATE movimientos SET tipo_movimiento = 'ingreso' WHERE tipo = 'abono' AND tipo_movimiento = 'compra'");

    database.exec('CREATE INDEX IF NOT EXISTS idx_movimientos_tipo_movimiento ON movimientos(tipo_movimiento)');
    database.exec('CREATE INDEX IF NOT EXISTS idx_movimientos_destino ON movimientos(cuenta_destino_id)');
  });
  migrar();
}

export async function query(sql, params = []) {
  const database = await getConnection();
  
  // Convertir SQL de MySQL a SQLite
  sql = sql.replace(/`/g, '')
    .replace(/MONTH\(([\w.]+)\)/g, 'CAST(strftime(\'%m\', $1) AS INTEGER)')
    .replace(/YEAR\(([\w.]+)\)/g, 'CAST(strftime(\'%Y\', $1) AS INTEGER)')
    .replace(/DATE_SUB\(NOW\(\), INTERVAL (\d+) MONTH\)/g, 'date(\'now\', \'-$1 months\')')
    .replace(/CURRENT_DATE/g, 'date(\'now\')')
    .replace(/NOW\(\)/g, 'datetime(\'now\')');

  try {
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      const stmt = database.prepare(sql);
      const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
      return [rows];
    } else if (sql.trim().toUpperCase().startsWith('INSERT')) {
      const stmt = database.prepare(sql);
      const result = params.length > 0 ? stmt.run(...params) : stmt.run();
      return [{ insertId: result.lastInsertRowid }];
    } else if (sql.trim().toUpperCase().startsWith('UPDATE') || 
               sql.trim().toUpperCase().startsWith('DELETE')) {
      const stmt = database.prepare(sql);
      const result = params.length > 0 ? stmt.run(...params) : stmt.run();
      return [{ affectedRows: result.changes }];
    } else {
      database.exec(sql);
      return [{}];
    }
  } catch (error) {
    console.error('SQL Error:', error.message, 'Query:', sql);
    throw error;
  }
}
