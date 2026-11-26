import express from 'express';
import session from 'express-session';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import cuentasRoutes from './routes/cuentas.js';
import categoriasRoutes from './routes/categorias.js';
import movimientosRoutes from './routes/movimientos.js';
import importarRoutes from './routes/importar.js';
import dashboardRoutes from './routes/dashboard.js';
import prestamosRoutes from './routes/prestamos.js';
import { planAhorroRouter, gastosFijosRouter } from './routes/planAhorro.js';
import { ensureStorageDirs, iniciarLimpiezaTemporales } from './storage.js';
import { inicializarDB } from './db.js';
import { iniciarBot, detenerBot } from './telegram/bot.js';
import { decidirWeb, registrarEscucha } from './web.js';
import { describirErrorBD } from './motorDB.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

/** Construye la app de Express (middleware, API y, si se pide, el frontend). Solo se llama con WEB_HABILITADA=true. */
function crearApp() {
  const app = express();

  // Middleware
  app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173',
    credentials: true
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Sesión
  app.use(session({
    secret: process.env.SESSION_SECRET || 'secreto-temporal-cambiar',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 horas
    }
  }));

  // Servir archivos estáticos (uploads desde ruta configurable)
  const uploadsPath = process.env.UPLOADS_PATH || path.join(__dirname, '../uploads');
  app.use('/uploads', express.static(uploadsPath));

  // Rutas API
  app.use('/api/auth', authRoutes);
  app.use('/api/cuentas', cuentasRoutes);
  app.use('/api/categorias', categoriasRoutes);
  app.use('/api/movimientos', movimientosRoutes);
  app.use('/api/importar', importarRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/prestamos', prestamosRoutes);
  app.use('/api/plan-ahorro', planAhorroRouter);
  app.use('/api/gastos-fijos', gastosFijosRouter);

  // Servir el frontend (client/dist) solo si SERVIR_FRONTEND=true. Por defecto no se sirve:
  // la app se usa desde el bot de Telegram y la API sigue disponible.
  if (process.env.SERVIR_FRONTEND === 'true') {
    app.use(express.static(path.join(__dirname, '../client/dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, '../client/dist/index.html'));
    });
  }

  return app;
}

/**
 * La web solo se levanta con WEB_HABILITADA=true, escucha únicamente en HOST (127.0.0.1 por defecto)
 * y no arranca sin una ADMIN_PASSWORD propia. Sin ella no hay Express ni puerto: solo el bot.
 */
function iniciarWeb() {
  const web = decidirWeb(process.env);
  if (!web.habilitada) {
    console.log('✓ Web deshabilitada (WEB_HABILITADA no es true): no se escucha ningún puerto, solo el bot');
    return false;
  }
  if (web.bloqueo) {
    console.error(`✗ La web NO se inició: ${web.bloqueo}`);
    return false;
  }

  const servidor = crearApp().listen(web.puerto, web.host, () => {
    registrarEscucha(servidor.address());
    console.log(`✓ Web escuchando en ${web.host}:${web.puerto}`);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`✓ Modo desarrollo - Frontend en http://localhost:5173`);
    }
  });
  servidor.on('error', (error) => {
    console.error(`✗ La web no pudo escuchar en ${web.host}:${web.puerto} (${error.code ?? error.name})`);
  });
  return true;
}

const ESPERA_REINTENTO_BD_MS = (Number(process.env.DB_REINTENTO_SEGUNDOS) || 30) * 1000;

/**
 * Inicializa la base de datos y, si no conecta (credenciales, MariaDB caído), lo dice con un mensaje
 * claro (nunca la clave) y reintenta cada 30 s. Así el proceso no se cierra y PM2 no lo reinicia en bucle.
 */
async function inicializarConReintentos() {
  for (;;) {
    try {
      await inicializarDB();
      return;
    } catch (error) {
      console.error(`✗ No se pudo inicializar la base de datos: ${describirErrorBD(error)}`);
      console.error(`  Reintento en ${Math.round(ESPERA_REINTENTO_BD_MS / 1000)} s (el bot arranca cuando la base responda).`);
      await new Promise(resolve => setTimeout(resolve, ESPERA_REINTENTO_BD_MS));
    }
  }
}

// Una promesa rechazada sin manejar no debe tumbar el arranque: se registra y se sigue
process.on('unhandledRejection', (motivo) => {
  console.error(`✗ Promesa rechazada sin manejar: ${motivo?.code ?? motivo?.name ?? 'error'}: ${String(motivo?.message ?? motivo).slice(0, 200)}`);
});

// Inicializar base de datos y servidor
async function iniciar() {
  try {
    await inicializarConReintentos();
    await ensureStorageDirs();
    iniciarLimpiezaTemporales();
    const hayWeb = iniciarWeb();

    // Iniciar bot de Telegram (si está configurado)
    await iniciarBot();

    // Sin web, el bot es lo único que mantiene vivo el proceso
    if (!hayWeb && !process.env.TELEGRAM_BOT_TOKEN) {
      console.error('✗ No hay nada que ejecutar: la web está deshabilitada y falta TELEGRAM_BOT_TOKEN. Cerrando.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error al iniciar servidor:', error);
    process.exit(1);
  }
}

// Manejar cierre graceful
process.on('SIGINT', async () => {
  console.log('\n⏹ Deteniendo servidor...');
  await detenerBot();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⏹ Deteniendo servidor...');
  await detenerBot();
  process.exit(0);
});

iniciar();
