import express from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { resolverTipos } from '../tiposMovimiento.js';
import { almacenamientoMulter, rutaRelativaDeMulter, resolverArchivo } from '../storage.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import crypto from 'crypto';
import { parse } from 'csv-parse/sync';
import xlsx from 'xlsx';
import pdfParse from 'pdf-parse';

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

// Parsear CSV
function parsearCSV(buffer, encoding = 'utf8') {
  const content = buffer.toString(encoding);
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true
  });
}

// Parsear Excel
function parsearExcel(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet);
}

// Parsear PDF (básico - extrae texto y busca patrones)
async function parsearPDF(buffer) {
  const data = await pdfParse(buffer);
  const lineas = data.text.split('\n').filter(l => l.trim());
  
  // Intentar detectar movimientos con patrones comunes
  const movimientos = [];
  const patronFecha = /(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/;
  const patronMonto = /\$?\s*([\d.,]+)/;
  
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i];
    const matchFecha = linea.match(patronFecha);
    const matchMonto = linea.match(patronMonto);
    
    if (matchFecha && matchMonto) {
      movimientos.push({
        fecha_raw: matchFecha[1],
        descripcion: linea.replace(patronFecha, '').replace(patronMonto, '').trim(),
        monto_raw: matchMonto[1]
      });
    }
  }
  
  return movimientos;
}

// Normalizar fecha
function normalizarFecha(fechaStr) {
  if (!fechaStr) return null;
  
  // Intentar varios formatos
  const formatos = [
    /(\d{1,2})[-/](\d{1,2})[-/](\d{4})/,  // DD-MM-YYYY o DD/MM/YYYY
    /(\d{1,2})[-/](\d{1,2})[-/](\d{2})/,  // DD-MM-YY o DD/MM/YY
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/   // YYYY-MM-DD
  ];
  
  for (const formato of formatos) {
    const match = fechaStr.match(formato);
    if (match) {
      let dia, mes, anio;
      
      if (match[1].length === 4) {
        // YYYY-MM-DD
        anio = match[1];
        mes = match[2].padStart(2, '0');
        dia = match[3].padStart(2, '0');
      } else {
        // DD-MM-YYYY o DD-MM-YY
        dia = match[1].padStart(2, '0');
        mes = match[2].padStart(2, '0');
        anio = match[3];
        
        if (anio.length === 2) {
          anio = parseInt(anio) < 50 ? `20${anio}` : `19${anio}`;
        }
      }
      
      return `${anio}-${mes}-${dia}`;
    }
  }
  
  return null;
}

// Normalizar monto
function normalizarMonto(montoStr) {
  if (!montoStr) return 0;
  
  const str = montoStr.toString().trim();
  // Eliminar símbolos de moneda y espacios
  const limpio = str.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(limpio) || 0;
}

// Detectar formato automáticamente
function detectarFormato(datos) {
  if (!datos || datos.length === 0) return null;
  
  const primeraFila = datos[0];
  const columnas = Object.keys(primeraFila).map(k => k.toLowerCase());
  
  // Banco de Chile
  if (columnas.some(c => c.includes('fecha') && c.includes('contable')) ||
      columnas.some(c => c.includes('cargo') || c.includes('abono'))) {
    return {
      banco: 'Banco de Chile',
      mapeo: {
        fecha: columnas.find(c => c.includes('fecha')),
        descripcion: columnas.find(c => c.includes('descripcion') || c.includes('detalle') || c.includes('glosa')),
        cargo: columnas.find(c => c.includes('cargo')),
        abono: columnas.find(c => c.includes('abono'))
      }
    };
  }
  
  // Banco Falabella / CMR
  if (columnas.some(c => c.includes('establecimiento')) ||
      columnas.some(c => c.includes('comercio'))) {
    return {
      banco: 'Banco Falabella',
      mapeo: {
        fecha: columnas.find(c => c.includes('fecha')),
        descripcion: columnas.find(c => c.includes('establecimiento') || c.includes('comercio') || c.includes('descripcion')),
        monto: columnas.find(c => c.includes('monto') || c.includes('importe'))
      }
    };
  }
  
  // Formato genérico
  return {
    banco: 'Genérico',
    mapeo: {
      fecha: columnas.find(c => c.includes('fecha')),
      descripcion: columnas.find(c => c.includes('descripcion') || c.includes('detalle') || c.includes('concepto')),
      monto: columnas.find(c => c.includes('monto') || c.includes('importe') || c.includes('valor')),
      cargo: columnas.find(c => c.includes('cargo') || c.includes('debe')),
      abono: columnas.find(c => c.includes('abono') || c.includes('haber'))
    }
  };
}

// Procesar datos según formato
function procesarDatos(datos, formato, mapeoCustom = null) {
  const mapeo = mapeoCustom || formato.mapeo;
  const movimientos = [];
  
  for (const fila of datos) {
    let fecha = null;
    let descripcion = '';
    let monto = 0;
    let tipo = 'cargo';
    
    // Extraer fecha
    if (mapeo.fecha) {
      fecha = normalizarFecha(fila[mapeo.fecha]);
    }
    
    // Extraer descripción
    if (mapeo.descripcion) {
      descripcion = fila[mapeo.descripcion] || '';
    }
    
    // Extraer monto y tipo
    if (mapeo.cargo && mapeo.abono) {
      const cargo = normalizarMonto(fila[mapeo.cargo]);
      const abono = normalizarMonto(fila[mapeo.abono]);
      
      if (cargo > 0) {
        monto = cargo;
        tipo = 'cargo';
      } else if (abono > 0) {
        monto = abono;
        tipo = 'abono';
      }
    } else if (mapeo.monto) {
      monto = Math.abs(normalizarMonto(fila[mapeo.monto]));
      
      // Detectar si es cargo o abono por el signo o columnas adicionales
      if (fila[mapeo.monto] && fila[mapeo.monto].toString().includes('-')) {
        tipo = 'cargo';
      } else {
        tipo = 'abono';
      }
    }
    
    if (fecha && descripcion && monto > 0) {
      movimientos.push({
        fecha,
        descripcion: descripcion.trim(),
        monto,
        tipo
      });
    }
  }
  
  return movimientos;
}

// Endpoint para subir y previsualizar
router.post('/preview', upload.single('archivo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    const buffer = await fs.readFile(req.file.path);
    
    let datos = [];
    let esManual = false;
    
    // Parsear según tipo
    if (ext === '.csv') {
      try {
        datos = parsearCSV(buffer);
      } catch (e) {
        // Intentar con otra codificación
        datos = parsearCSV(buffer, 'latin1');
      }
    } else if (['.xlsx', '.xls'].includes(ext)) {
      datos = parsearExcel(buffer);
    } else if (ext === '.pdf') {
      datos = await parsearPDF(buffer);
      esManual = true; // PDF siempre requiere revisión manual
    }
    
    if (datos.length === 0) {
      return res.status(400).json({ error: 'No se pudieron extraer datos del archivo' });
    }
    
    // Detectar formato
    const formato = detectarFormato(datos);
    
    // Procesar movimientos
    let movimientos = [];
    if (formato && !esManual) {
      movimientos = procesarDatos(datos, formato);
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
    
    // Aplicar autocategorización a los movimientos
    const [reglas] = await query('SELECT * FROM reglas_categoria WHERE activa = true');
    
    let importados = 0;
    for (const mov of movimientos) {
      // Buscar categoría automática
      let categoria_id = null;
      const descripcionLower = mov.descripcion.toLowerCase();
      
      for (const regla of reglas) {
        if (descripcionLower.includes(regla.texto_buscar.toLowerCase())) {
          categoria_id = regla.categoria_id;
          break;
        }
      }
      
      await query(
        `INSERT INTO movimientos (cuenta_id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id, importado_de)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        // abono -> ingreso, cargo -> compra
        [cuenta_id, mov.fecha, mov.descripcion, mov.monto, mov.tipo, resolverTipos({ tipo: mov.tipo }).tipo_movimiento, categoria_id, archivo]
      );
      
      importados++;
    }
    
    // Registrar archivo importado
    await query(
      `INSERT INTO archivos_importados (nombre_archivo, hash_archivo, cuenta_id, cantidad_movimientos, ruta_archivo)
       VALUES (?, ?, ?, ?, ?)`,
      [path.basename(archivo), hash, cuenta_id, importados, archivo]
    );
    
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
