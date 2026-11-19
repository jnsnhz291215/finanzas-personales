import express from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolverTipos } from '../tiposMovimiento.js';
import { almacenamientoMulter, rutaRelativaDeMulter, resolverArchivo } from '../storage.js';
import {
  parsearCSV,
  parsearExcel,
  procesarDatos,
  analizarCartola,
  registrarImportacion
} from '../cartolas.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.use(requireAuth);

// Las cartolas se guardan en <FINANZAS_STORAGE>/cartolas/{YYYY-MM}/ (ver storage.js)
const storage = almacenamientoMulter('cartolas');

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.csv', '.xlsx', '.xls', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido. Solo CSV, Excel o PDF'));
    }
  }
});

// Función para calcular hash del archivo
async function calcularHashArchivo(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

// Endpoint para subir y previsualizar
router.post('/preview', upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    const buffer = await fs.readFile(req.file.path);
    
    const { datos, esManual, formato, movimientos } = await analizarCartola(buffer, ext);

    if (datos.length === 0) {
      return res.status(400).json({ error: 'No se pudieron extraer datos del archivo' });
    }
    
    // Calcular hash
    const hash = await calcularHashArchivo(req.file.path);
    
    // Verificar si ya fue importado
    const [archivosExistentes] = await query(
      'SELECT * FROM archivos_importados WHERE hash_archivo = ?',
      [hash]
    );
    
    const yaImportado = archivosExistentes.length > 0;
    
    res.json({
      // Ruta relativa a la raíz del almacenamiento; el cliente la devuelve al confirmar
      archivo: rutaRelativaDeMulter('cartolas', req.file),
      nombreOriginal: req.file.originalname,
      hash,
      yaImportado,
      formato: formato?.banco || 'Desconocido',
      columnas: datos.length > 0 ? Object.keys(datos[0]) : [],
      movimientosDetectados: movimientos.length,
      movimientos: movimientos.slice(0, 50), // Primeros 50 para preview
      requiereMapeoManual: movimientos.length === 0 || esManual,
      datosRaw: datos.slice(0, 10) // Primeras 10 filas para mapeo manual
    });
  } catch (error) {
    console.error('Error al procesar archivo:', error);
    res.status(500).json({ error: 'Error al procesar archivo: ' + error.message });
  }
});

// Endpoint para confirmar importación
router.post('/confirmar', async (req, res) => {
  try {
    const { archivo, hash, cuenta_id, movimientos, mapeoCustom } = req.body;
    
    if (!archivo || !cuenta_id || !movimientos || movimientos.length === 0) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    // El archivo debe existir dentro del almacenamiento (no se acepta una ruta cualquiera)
    if (!(await resolverArchivo(archivo))) {
      return res.status(400).json({ error: 'El archivo de la cartola ya no está disponible. Súbelo de nuevo.' });
    }
    
    // Verificar si ya fue importado
    const [archivosExistentes] = await query(
      'SELECT * FROM archivos_importados WHERE hash_archivo = ?',
      [hash]
    );
    
    if (archivosExistentes.length > 0) {
      return res.status(400).json({ 
        error: 'Este archivo ya fue importado anteriormente',
        fecha: archivosExistentes[0].fecha_importacion
      });
    }
    
    const { importados } = await registrarImportacion({ archivo, hash, cuentaId: cuenta_id, movimientos });
    
    res.json({ 
      success: true, 
      importados,
      mensaje: `Se importaron ${importados} movimientos correctamente`
    });
  } catch (error) {
    console.error('Error al confirmar importación:', error);
    res.status(500).json({ error: 'Error al importar movimientos: ' + error.message });
  }
});

// Endpoint para mapeo manual
router.post('/mapear', upload.single('archivo'), async (req, res) => {
  try {
    const { mapeo } = req.body;
    
    if (!req.file || !mapeo) {
      return res.status(400).json({ error: 'Archivo y mapeo son requeridos' });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    const buffer = await fs.readFile(req.file.path);
    
    let datos = [];
    if (ext === '.csv') {
      datos = parsearCSV(buffer);
    } else if (['.xlsx', '.xls'].includes(ext)) {
      datos = parsearExcel(buffer);
    }
    
    const mapeoObj = JSON.parse(mapeo);
    const formato = { banco: 'Manual', mapeo: mapeoObj };
    const movimientos = procesarDatos(datos, formato);
    
    res.json({
      movimientosDetectados: movimientos.length,
      movimientos: movimientos.slice(0, 50)
    });
  } catch (error) {
    console.error('Error en mapeo manual:', error);
    res.status(500).json({ error: 'Error al mapear archivo: ' + error.message });
  }
});

// Listar archivos importados
router.get('/historial', async (req, res) => {
  try {
    const [archivos] = await query(`
      SELECT a.*, c.nombre as cuenta_nombre
      FROM archivos_importados a
      LEFT JOIN cuentas c ON a.cuenta_id = c.id
      ORDER BY a.fecha_importacion DESC
    `);
    res.json(archivos);
  } catch (error) {
    console.error('Error al obtener historial:', error);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

export default router;
