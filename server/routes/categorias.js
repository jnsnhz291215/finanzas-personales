import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

// Listar categorías
router.get('/', async (req, res) => {
  try {
    const [categorias] = await query('SELECT * FROM categorias ORDER BY nombre');
    res.json(categorias);
  } catch (error) {
    console.error('Error al obtener categorías:', error);
    res.status(500).json({ error: 'Error al obtener categorías' });
  }
});

// Crear categoría
router.post('/', async (req, res) => {
  try {
    const { nombre, color, icono } = req.body;
    
    if (!nombre) {
      return res.status(400).json({ error: 'Nombre es requerido' });
    }
    
    const [result] = await query(
      'INSERT INTO categorias (nombre, color, icono) VALUES (?, ?, ?)',
      [nombre, color || '#6B7280', icono || 'fa-folder']
    );
    
    const [nuevaCategoria] = await query('SELECT * FROM categorias WHERE id = ?', [result.insertId]);
    res.status(201).json(nuevaCategoria[0]);
  } catch (error) {
    console.error('Error al crear categoría:', error);
    res.status(500).json({ error: 'Error al crear categoría' });
  }
});

// Actualizar categoría
router.put('/:id', async (req, res) => {
  try {
    const { nombre, color, icono } = req.body;
    
    await query(
      'UPDATE categorias SET nombre = ?, color = ?, icono = ? WHERE id = ?',
      [nombre, color, icono, req.params.id]
    );
    
    const [categoriaActualizada] = await query('SELECT * FROM categorias WHERE id = ?', [req.params.id]);
    res.json(categoriaActualizada[0]);
  } catch (error) {
    console.error('Error al actualizar categoría:', error);
    res.status(500).json({ error: 'Error al actualizar categoría' });
  }
});

// Eliminar categoría
router.delete('/:id', async (req, res) => {
  try {
    await query('DELETE FROM categorias WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error al eliminar categoría:', error);
    res.status(500).json({ error: 'Error al eliminar categoría' });
  }
});

// Reglas de autocategorización
router.get('/reglas', async (req, res) => {
  try {
    const [reglas] = await query(`
      SELECT r.*, c.nombre as categoria_nombre 
      FROM reglas_categoria r
      JOIN categorias c ON r.categoria_id = c.id
      ORDER BY r.creado_en DESC
    `);
    res.json(reglas);
  } catch (error) {
    console.error('Error al obtener reglas:', error);
    res.status(500).json({ error: 'Error al obtener reglas' });
  }
});

router.post('/reglas', async (req, res) => {
  try {
    const { texto_buscar, categoria_id } = req.body;
    
    if (!texto_buscar || !categoria_id) {
      return res.status(400).json({ error: 'Texto y categoría son requeridos' });
    }
    
    const [result] = await query(
      'INSERT INTO reglas_categoria (texto_buscar, categoria_id) VALUES (?, ?)',
      [texto_buscar, categoria_id]
    );
    
    const [nuevaRegla] = await query(`
      SELECT r.*, c.nombre as categoria_nombre 
      FROM reglas_categoria r
      JOIN categorias c ON r.categoria_id = c.id
      WHERE r.id = ?
    `, [result.insertId]);
    
    res.status(201).json(nuevaRegla[0]);
  } catch (error) {
    console.error('Error al crear regla:', error);
    res.status(500).json({ error: 'Error al crear regla' });
  }
});

router.delete('/reglas/:id', async (req, res) => {
  try {
    await query('DELETE FROM reglas_categoria WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error al eliminar regla:', error);
    res.status(500).json({ error: 'Error al eliminar regla' });
  }
});

export default router;
