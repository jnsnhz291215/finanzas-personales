import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { resolverTipos, requiereDestino } from '../tiposMovimiento.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

router.use(requireAuth);

// Configurar multer para respaldos (usa ruta configurable del .env)
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = process.env.RESPALDOS_PATH || path.join(__dirname, '../../uploads/respaldos');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

/**
 * pago_tarjeta y transferencia_propia exigen una cuenta destino distinta del origen;
 * el resto de los tipos no lleva cuenta destino.
 */
function validarDestino(tipoMovimiento, cuentaId, cuentaDestinoId) {
  if (!requiereDestino(tipoMovimiento)) {
    return { id: null };
  }
  if (!cuentaDestinoId) {
    return { error: 'Falta la cuenta destino' };
  }
  if (String(cuentaDestinoId) === String(cuentaId)) {
    return { error: 'La cuenta destino debe ser distinta de la cuenta origen' };
  }
  return { id: cuentaDestinoId };
}

// Listar movimientos con filtros
router.get('/', async (req, res) => {
  try {
    const { mes, anio, cuenta_id, categoria_id, es_prestamo, persona_prestamo } = req.query;
    
    let sql = `
      SELECT m.*, 
             c.nombre as cuenta_nombre,
             cd.nombre as cuenta_destino_nombre,
             cat.nombre as categoria_nombre,
             cat.color as categoria_color
      FROM movimientos m
      LEFT JOIN cuentas c ON m.cuenta_id = c.id
      LEFT JOIN cuentas cd ON m.cuenta_destino_id = cd.id
      LEFT JOIN categorias cat ON m.categoria_id = cat.id
      WHERE 1=1
    `;
    const params = [];
    
    if (mes && anio) {
      sql += ' AND MONTH(m.fecha) = ? AND YEAR(m.fecha) = ?';
      params.push(mes, anio);
    }
    
    if (cuenta_id) {
      // Incluye los movimientos que llegan a la cuenta (pagos de tarjeta, transferencias propias)
      sql += ' AND (m.cuenta_id = ? OR m.cuenta_destino_id = ?)';
      params.push(cuenta_id, cuenta_id);
    }
    
    if (categoria_id) {
      sql += ' AND m.categoria_id = ?';
      params.push(categoria_id);
    }
    
    if (es_prestamo === 'true') {
      sql += ' AND m.es_prestamo = true';
    }
    
    if (persona_prestamo) {
      sql += ' AND m.persona_prestamo = ?';
      params.push(persona_prestamo);
    }
    
    sql += ' ORDER BY m.fecha DESC, m.creado_en DESC';
    
    const [movimientos] = await query(sql, params);
    res.json(movimientos);
  } catch (error) {
    console.error('Error al obtener movimientos:', error);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

// Obtener un movimiento
router.get('/:id', async (req, res) => {
  try {
    const [movimientos] = await query(`
      SELECT m.*, 
             c.nombre as cuenta_nombre,
             cd.nombre as cuenta_destino_nombre,
             cat.nombre as categoria_nombre
      FROM movimientos m
      LEFT JOIN cuentas c ON m.cuenta_id = c.id
      LEFT JOIN cuentas cd ON m.cuenta_destino_id = cd.id
      LEFT JOIN categorias cat ON m.categoria_id = cat.id
      WHERE m.id = ?
    `, [req.params.id]);
    
    if (movimientos.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    
    res.json(movimientos[0]);
  } catch (error) {
    console.error('Error al obtener movimiento:', error);
    res.status(500).json({ error: 'Error al obtener movimiento' });
  }
});

// Crear movimiento
router.post('/', upload.single('respaldo'), async (req, res) => {
  try {
    const { cuenta_id, fecha, descripcion, monto, categoria_id, persona_prestamo, es_prestamo, notas } = req.body;
    
    if (!cuenta_id || !fecha || !descripcion || !monto || !(req.body.tipo || req.body.tipo_movimiento)) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    
    const { tipo, tipo_movimiento } = resolverTipos(req.body);
    const destino = validarDestino(tipo_movimiento, cuenta_id, req.body.cuenta_destino_id);
    if (destino.error) {
      return res.status(400).json({ error: destino.error });
    }
    
    const archivo_respaldo = req.file ? `/uploads/respaldos/${req.file.filename}` : null;
    
    const [result] = await query(
      `INSERT INTO movimientos (cuenta_id, cuenta_destino_id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id, persona_prestamo, es_prestamo, notas, archivo_respaldo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [cuenta_id, destino.id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id || null, persona_prestamo || null, es_prestamo === 'true' || false, notas || null, archivo_respaldo]
    );
    
    const [nuevoMovimiento] = await query('SELECT * FROM movimientos WHERE id = ?', [result.insertId]);
    res.status(201).json(nuevoMovimiento[0]);
  } catch (error) {
    console.error('Error al crear movimiento:', error);
    res.status(500).json({ error: 'Error al crear movimiento' });
  }
});

// Actualizar movimiento
router.put('/:id', upload.single('respaldo'), async (req, res) => {
  try {
    const { cuenta_id, fecha, descripcion, monto, categoria_id, persona_prestamo, es_prestamo, notas } = req.body;
    
    const { tipo, tipo_movimiento } = resolverTipos(req.body);
    const destino = validarDestino(tipo_movimiento, cuenta_id, req.body.cuenta_destino_id);
    if (destino.error) {
      return res.status(400).json({ error: destino.error });
    }
    
    let archivo_respaldo = req.body.archivo_respaldo_actual;
    
    if (req.file) {
      archivo_respaldo = `/uploads/respaldos/${req.file.filename}`;
    }
    
    await query(
      `UPDATE movimientos 
       SET cuenta_id = ?, cuenta_destino_id = ?, fecha = ?, descripcion = ?, monto = ?, tipo = ?, tipo_movimiento = ?,
           categoria_id = ?, persona_prestamo = ?, es_prestamo = ?, notas = ?, archivo_respaldo = ?
       WHERE id = ?`,
      [cuenta_id, destino.id, fecha, descripcion, monto, tipo, tipo_movimiento, categoria_id || null, persona_prestamo || null, es_prestamo === 'true' || false, notas || null, archivo_respaldo, req.params.id]
    );
    
    const [movimientoActualizado] = await query('SELECT * FROM movimientos WHERE id = ?', [req.params.id]);
    res.json(movimientoActualizado[0]);
  } catch (error) {
    console.error('Error al actualizar movimiento:', error);
    res.status(500).json({ error: 'Error al actualizar movimiento' });
  }
});

// Eliminar movimiento
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM movimientos WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error al eliminar movimiento:', error);
    res.status(500).json({ error: 'Error al eliminar movimiento' });
  }
});

// Autocategorizar movimiento
router.post('/:id/autocategorizar', async (req, res) => {
  try {
    const [movimientos] = await query('SELECT * FROM movimientos WHERE id = ?', [req.params.id]);
    
    if (movimientos.length === 0) {
      return res.status(404).json({ error: 'Movimiento no encontrado' });
    }
    
    const movimiento = movimientos[0];
    const descripcion = movimiento.descripcion.toLowerCase();
    
    const [reglas] = await query('SELECT * FROM reglas_categoria WHERE activa = true');
    
    let categoria_id = null;
    for (const regla of reglas) {
      if (descripcion.includes(regla.texto_buscar.toLowerCase())) {
        categoria_id = regla.categoria_id;
        break;
      }
    }
    
    if (categoria_id) {
      await query('UPDATE movimientos SET categoria_id = ? WHERE id = ?', [categoria_id, req.params.id]);
    }
    
    const [movimientoActualizado] = await query('SELECT * FROM movimientos WHERE id = ?', [req.params.id]);
    res.json(movimientoActualizado[0]);
  } catch (error) {
    console.error('Error al autocategorizar:', error);
    res.status(500).json({ error: 'Error al autocategorizar' });
  }
});

export default router;
