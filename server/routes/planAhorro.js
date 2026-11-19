import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  obtenerPlan,
  guardarPlan,
  validarPorcentajes,
  validarGastoFijo,
  listarGastosFijos,
  crearGastoFijo,
  actualizarGastoFijo,
  desactivarGastoFijo
} from '../planAhorro.js';

// /api/plan-ahorro
export const planAhorroRouter = express.Router();
planAhorroRouter.use(requireAuth);

// Resumen calculado del mes actual (hora de Chile)
planAhorroRouter.get('/', async (req, res) => {
  try {
    res.json(await obtenerPlan());
  } catch (error) {
    console.error('Error al obtener el plan de ahorro:', error.code ?? error.message);
    res.status(500).json({ error: 'Error al obtener el plan de ahorro' });
  }
});

// Porcentajes e ingreso base (los porcentajes deben sumar 100)
planAhorroRouter.put('/', async (req, res) => {
  try {
    const porcentajes = validarPorcentajes(req.body);
    if (!porcentajes.ok) {
      return res.status(400).json({ error: porcentajes.error });
    }

    // ingreso_base vacío o null = usar los ingresos reales del mes
    const bruto = req.body.ingreso_base;
    let ingresoBase = null;
    if (bruto !== null && bruto !== undefined && bruto !== '') {
      ingresoBase = Number(bruto);
      if (!Number.isFinite(ingresoBase) || ingresoBase < 0) {
        return res.status(400).json({ error: 'El ingreso base debe ser un número mayor o igual a 0' });
      }
    }

    await guardarPlan({ ingreso_base: ingresoBase, ...porcentajes.valores });
    res.json(await obtenerPlan());
  } catch (error) {
    console.error('Error al guardar el plan de ahorro:', error.code ?? error.message);
    res.status(500).json({ error: 'Error al guardar el plan de ahorro' });
  }
});

// /api/gastos-fijos
export const gastosFijosRouter = express.Router();
gastosFijosRouter.use(requireAuth);

gastosFijosRouter.get('/', async (req, res) => {
  try {
    res.json(await listarGastosFijos({ incluirInactivos: req.query.todos === 'true' }));
  } catch (error) {
    console.error('Error al listar gastos fijos:', error.code ?? error.message);
    res.status(500).json({ error: 'Error al obtener los gastos fijos' });
  }
});

gastosFijosRouter.post('/', async (req, res) => {
  try {
    const datos = validarGastoFijo(req.body);
    if (!datos.ok) {
      return res.status(400).json({ error: datos.error });
    }

    const id = await crearGastoFijo(datos.valores);
    const creado = (await listarGastosFijos({ incluirInactivos: true })).find(f => Number(f.id) === Number(id));
    res.status(201).json(creado);
  } catch (error) {
    console.error('Error al crear gasto fijo:', error.code ?? error.message);
    res.status(500).json({ error: 'Error al crear el gasto fijo' });
  }
});

gastosFijosRouter.put('/:id', async (req, res) => {
  try {
    const datos = validarGastoFijo(req.body);
    if (!datos.ok) {
      return res.status(400).json({ error: datos.error });
    }

    const existentes = await listarGastosFijos({ incluirInactivos: true });
    if (!existentes.some(f => String(f.id) === req.params.id)) {
      return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    }

    // activo se puede reactivar con PUT; por defecto se conserva
    const actual = existentes.find(f => String(f.id) === req.params.id);
    const activo = req.body.activo === undefined ? actual.activo : Boolean(req.body.activo);
    await actualizarGastoFijo(req.params.id, datos.valores, activo);

    const actualizado = (await listarGastosFijos({ incluirInactivos: true })).find(f => String(f.id) === req.params.id);
    res.json(actualizado);
  } catch (error) {
    console.error('Error al actualizar gasto fijo:', error.code ?? error.message);
    res.status(500).json({ error: 'Error al actualizar el gasto fijo' });
  }
});

// Soft delete: activo = 0, no se borra la fila
gastosFijosRouter.delete('/:id', async (req, res) => {
  try {
    const desactivado = await desactivarGastoFijo(req.params.id);
    if (!desactivado) {
      return res.status(404).json({ error: 'Gasto fijo no encontrado' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error al desactivar gasto fijo:', error.code ?? error.message);
    res.status(500).json({ error: 'Error al eliminar el gasto fijo' });
  }
});
