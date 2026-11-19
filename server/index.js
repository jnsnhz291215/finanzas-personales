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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3005;

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

// Inicializar base de datos y servidor
async function iniciar() {
  try {
    await inicializarDB();
    await ensureStorageDirs();
    iniciarLimpiezaTemporales();
    app.listen(PORT, () => {
      console.log(`✓ Servidor corriendo en puerto ${PORT}`);
      console.log(`✓ Base de datos conectada`);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`✓ Modo desarrollo - Frontend en http://localhost:5173`);
      }
    });
    
    // Iniciar bot de Telegram (si está configurado)
    await iniciarBot();
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
