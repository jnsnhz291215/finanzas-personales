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
