import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { resumenDeudas, registrarPagoDeuda } from '../deudas.js';

const router = express.Router();

router.use(requireAuth);

// Obtener resumen de préstamos por persona
router.get('/resumen', async (req, res) => {
  try {
    res.json(await resumenDeudas());
  } catch (error) {
    console.error('Error al obtener resumen de préstamos:', error);
    res.status(500).json({ error: 'Error al obtener resumen' });
  }
});

// Obtener movimientos de una persona
router.get('/persona/:nombre', async (req, res) => {
  try {
    const [movimientos] = await query(`
      SELECT m.*, c.nombre as cuenta_nombre
      FROM movimientos m
      LEFT JOIN cuentas c ON m.cuenta_id = c.id
      WHERE m.es_prestamo = true AND m.persona_prestamo = ?
      ORDER BY m.fecha DESC
    `, [req.params.nombre]);
    
    res.json(movimientos);
  } catch (error) {
    console.error('Error al obtener movimientos de persona:', error);
    res.status(500).json({ error: 'Error al obtener movimientos' });
  }
});

// Registrar pago
router.post('/pagos', async (req, res) => {
  try {
    const { persona, monto, fecha, notas } = req.body;
    
    if (!persona || !monto || !fecha) {
      return res.status(400).json({ error: 'Persona, monto y fecha son requeridos' });
    }
    
    res.status(201).json(await registrarPagoDeuda({ persona, monto, fecha, notas }));
  } catch (error) {
    console.error('Error al registrar pago:', error);
    res.status(500).json({ error: 'Error al registrar pago' });
  }
});

// Listar pagos de una persona
router.get('/pagos/:persona', async (req, res) => {
  try {
    const [pagos] = await query(
      'SELECT * FROM pagos_prestamos WHERE persona = ? ORDER BY fecha DESC',
      [req.params.persona]
    );
    res.json(pagos);
  } catch (error) {
    console.error('Error al obtener pagos:', error);
    res.status(500).json({ error: 'Error al obtener pagos' });
  }
});

// Eliminar pago
router.delete('/pagos/:id', async (req, res) => {
  try {
    await query('DELETE FROM pagos_prestamos WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error al eliminar pago:', error);
    res.status(500).json({ error: 'Error al eliminar pago' });
  }
});

export default router;
