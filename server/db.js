import dotenv from 'dotenv';
dotenv.config();

// Siempre usar SQLite para la demo, comentar para usar MySQL en producción real
const USE_SQLITE = true; // Cambiar a false cuando tengas MariaDB configurado

let dbModule;

if (!USE_SQLITE && process.env.DB_HOST && process.env.DB_HOST !== 'localhost') {
  // Usar MySQL en producción
  const mysql = (await import('mysql2/promise')).default;
  const bcrypt = (await import('bcrypt')).default;
  
  const config = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'finanzas_personales_juan',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };

  let pool;

  /**
   * Migración idempotente (MariaDB): agrega 'efectivo' al ENUM de cuentas.tipo.
   */
  async function migrarTipoEfectivo(connection) {
    const [filas] = await connection.query(
      `SELECT COLUMN_TYPE AS tipo FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cuentas' AND COLUMN_NAME = 'tipo'`
    );
    if (filas.length === 0 || String(filas[0].tipo).includes("'efectivo'")) return;

    await connection.query(
      `ALTER TABLE cuentas MODIFY COLUMN tipo
         ENUM('cuenta_corriente', 'cuenta_vista', 'cuenta_ahorro', 'tarjeta_credito', 'tarjeta_debito', 'efectivo') NOT NULL`
    );
  }

  /**
   * Migración idempotente (MariaDB): tabla datos_transferencia, con mis propios datos para que
   * me depositen. Va aparte de cuentas porque cuenta_id es opcional y porque la API de cuentas
   * devuelve todas sus columnas.
   */
  async function migrarDatosTransferencia(connection) {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS datos_transferencia (
        id INT PRIMARY KEY AUTO_INCREMENT,
        cuenta_id INT NULL,
        alias VARCHAR(100) NOT NULL,
        nombre_titular VARCHAR(150) NOT NULL,
        rut VARCHAR(12) NOT NULL,
        banco VARCHAR(100) NOT NULL,
        tipo_cuenta ENUM('corriente', 'vista', 'rut', 'ahorro') NOT NULL,
        numero_cuenta VARCHAR(30) NOT NULL,
        email VARCHAR(150) NULL,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL,
        INDEX idx_banco_numero (banco, numero_cuenta)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  /**
   * Migración idempotente (MariaDB): agrega ultimos4 (solo los 4 últimos dígitos de una
   * tarjeta o cuenta; nunca el número completo) y titular a cuentas.
   */
  async function migrarDatosCuenta(connection) {
    const [existentes] = await connection.query(
      `SELECT COLUMN_NAME AS nombre FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cuentas'
         AND COLUMN_NAME IN ('ultimos4', 'titular')`
    );
    const columnas = existentes.map(c => c.nombre);

    if (!columnas.includes('ultimos4')) {
      await connection.query('ALTER TABLE cuentas ADD COLUMN ultimos4 VARCHAR(4) NULL AFTER numero_cuenta');
    }
    if (!columnas.includes('titular')) {
      await connection.query('ALTER TABLE cuentas ADD COLUMN titular VARCHAR(150) NULL AFTER ultimos4');
    }
  }

  /**
   * Migración idempotente (MariaDB): agrega tipo_movimiento y cuenta_destino_id a movimientos.
   * Registros existentes: abono -> ingreso, cargo -> compra.
   */
  async function migrarTipoMovimiento(connection) {
    const [existentes] = await connection.query(
      `SELECT COLUMN_NAME AS nombre FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'movimientos'
         AND COLUMN_NAME IN ('tipo_movimiento', 'cuenta_destino_id')`
    );
    const columnas = existentes.map(c => c.nombre);

    if (!columnas.includes('tipo_movimiento')) {
      await connection.query(
        `ALTER TABLE movimientos ADD COLUMN tipo_movimiento
           ENUM('compra', 'pago_tarjeta', 'transferencia_propia', 'transferencia_terceros', 'ingreso', 'otro')
           NOT NULL DEFAULT 'compra' AFTER tipo,
           ADD INDEX idx_tipo_movimiento (tipo_movimiento)`
      );
    }

    if (!columnas.includes('cuenta_destino_id')) {
      await connection.query(
        `ALTER TABLE movimientos ADD COLUMN cuenta_destino_id INT NULL AFTER cuenta_id,
           ADD INDEX idx_cuenta_destino (cuenta_destino_id),
           ADD CONSTRAINT fk_movimientos_cuenta_destino
             FOREIGN KEY (cuenta_destino_id) REFERENCES cuentas(id) ON DELETE SET NULL`
      );
    }

    // Backfill y reparación (idempotente): un abono clasificado como compra pasa a ingreso
    await connection.query(
      "UPDATE movimientos SET tipo_movimiento = 'ingreso' WHERE tipo = 'abono' AND tipo_movimiento = 'compra'"
    );
  }

  dbModule = {
    getConnection: async function() {
      if (!pool) {
        pool = mysql.createPool(config);
      }
      return pool;
    },

    inicializarDB: async function() {
      try {
        const connection = await this.getConnection();
        await connection.query('SELECT 1');
        console.log('✓ Conexión a MariaDB/MySQL establecida');
        
        await migrarTipoMovimiento(connection);
        await migrarDatosCuenta(connection);
        await migrarTipoEfectivo(connection);
        await migrarDatosTransferencia(connection);
        
        const [usuarios] = await connection.query('SELECT * FROM usuario LIMIT 1');
        
        if (usuarios.length === 0) {
          const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'cambiar123', 10);
          await connection.query(
            'INSERT INTO usuario (nombre, email, password_hash) VALUES (?, ?, ?)',
            ['Juan', 'juan@finanzas.cl', passwordHash]
          );
          console.log('✓ Usuario administrador creado (email: juan@finanzas.cl)');
        }
        
        return connection;
      } catch (error) {
        console.error('Error al inicializar base de datos:', error.message);
        throw error;
      }
    },

    query: async function(sql, params) {
      const connection = await this.getConnection();
      return connection.query(sql, params);
    }
  };
} else {
  // Usar SQLite (para desarrollo/demo)
  console.log('⚠ Usando SQLite para desarrollo/demo (cambiar USE_SQLITE a false en db.js para MariaDB)');
  dbModule = await import('./db-sqlite.js');
}

export const { getConnection, inicializarDB, query } = dbModule;
