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
        tipo TEXT NOT NULL CHECK(tipo IN ('cuenta_corriente', 'cuenta_vista', 'cuenta_ahorro', 'tarjeta_credito', 'tarjeta_debito')),
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
