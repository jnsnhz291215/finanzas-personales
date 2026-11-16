import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

// Listar todas las cuentas
router.get('/', async (req, res) => {
  try {
    const [cuentas] = await query(
      'SELECT * FROM cuentas ORDER BY creado_en DESC'
    );
    res.json(cuentas);
  } catch (error) {
    console.error('Error al obtener cuentas:', error);
    res.status(500).json({ error: 'Error al obtener cuentas' });
  }
});

// Obtener una cuenta
router.get('/:id', async (req, res) => {
  try {
    const [cuentas] = await query(
      'SELECT * FROM cuentas WHERE id = ?',
      [req.params.id]
    );
    
    if (cuentas.length === 0) {
      return res.status(404).json({ error: 'Cuenta no encontrada' });
    }
    
    res.json(cuentas[0]);
  } catch (error) {
    console.error('Error al obtener cuenta:', error);
    res.status(500).json({ error: 'Error al obtener cuenta' });
  }
});

// Crear cuenta
router.post('/', async (req, res) => {
  try {
    const { nombre, tipo, banco, numero_cuenta, cupo_total, dia_facturacion, dia_vencimiento, notas } = req.body;
    
    if (!nombre || !tipo) {
      return res.status(400).json({ error: 'Nombre y tipo son requeridos' });
    }
    
    const [result] = await query(
      `INSERT INTO cuentas (nombre, tipo, banco, numero_cuenta, cupo_total, dia_facturacion, dia_vencimiento, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [nombre, tipo, banco || null, numero_cuenta || null, cupo_total || null, dia_facturacion || null, dia_vencimiento || null, notas || null]
    );
    
    const [nuevaCuenta] = await query('SELECT * FROM cuentas WHERE id = ?', [result.insertId]);
    res.status(201).json(nuevaCuenta[0]);
  } catch (error) {
    console.error('Error al crear cuenta:', error);
    res.status(500).json({ error: 'Error al crear cuenta' });
  }
});

// Actualizar cuenta
router.put('/:id', async (req, res) => {
  try {
    const { nombre, tipo, banco, numero_cuenta, cupo_total, dia_facturacion, dia_vencimiento, activa, notas } = req.body;
    
    await query(
      `UPDATE cuentas 
       SET nombre = ?, tipo = ?, banco = ?, numero_cuenta = ?, cupo_total = ?, 
           dia_facturacion = ?, dia_vencimiento = ?, activa = ?, notas = ?
       WHERE id = ?`,
      [nombre, tipo, banco, numero_cuenta, cupo_total, dia_facturacion, dia_vencimiento, activa, notas, req.params.id]
    );
    
    const [cuentaActualizada] = await query('SELECT * FROM cuentas WHERE id = ?', [req.params.id]);
    res.json(cuentaActualizada[0]);
  } catch (error) {
    console.error('Error al actualizar cuenta:', error);
    res.status(500).json({ error: 'Error al actualizar cuenta' });
  }
});

// Eliminar cuenta
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM cuentas WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error al eliminar cuenta:', error);
    res.status(500).json({ error: 'Error al eliminar cuenta' });
  }
});

export default router;
