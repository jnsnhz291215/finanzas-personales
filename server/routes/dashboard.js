import express from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.use(requireAuth);

// Resumen del mes actual
router.get('/resumen', async (req, res) => {
  try {
    const { mes, anio } = req.query;
    const mesActual = mes || new Date().getMonth() + 1;
    const anioActual = anio || new Date().getFullYear();
    
    // Ingresos y gastos del mes
    const [totales] = await query(`
      SELECT 
        SUM(CASE WHEN tipo = 'abono' THEN monto ELSE 0 END) as ingresos,
        SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE 0 END) as gastos
      FROM movimientos
      WHERE MONTH(fecha) = ? AND YEAR(fecha) = ?
    `, [mesActual, anioActual]);
    
    const ingresos = parseFloat(totales[0].ingresos) || 0;
    const gastos = parseFloat(totales[0].gastos) || 0;
    const saldo = ingresos - gastos;
    
    // Gastos por categoría
    const [gastosCategoria] = await query(`
      SELECT 
        c.id,
        c.nombre,
        c.color,
        c.icono,
        SUM(m.monto) as total
      FROM movimientos m
      JOIN categorias c ON m.categoria_id = c.id
      WHERE m.tipo = 'cargo' 
        AND MONTH(m.fecha) = ? 
        AND YEAR(m.fecha) = ?
      GROUP BY c.id, c.nombre, c.color, c.icono
      ORDER BY total DESC
    `, [mesActual, anioActual]);
    
    // Gastos sin categoría
    const [sinCategoria] = await query(`
      SELECT SUM(monto) as total
      FROM movimientos
      WHERE tipo = 'cargo' 
        AND categoria_id IS NULL
        AND MONTH(fecha) = ? 
        AND YEAR(fecha) = ?
    `, [mesActual, anioActual]);
    
    const totalSinCategoria = parseFloat(sinCategoria[0].total) || 0;
    
    if (totalSinCategoria > 0) {
      gastosCategoria.push({
        id: null,
        nombre: 'Sin categoría',
        color: '#9CA3AF',
        icono: 'fa-question',
        total: totalSinCategoria
      });
    }
    
    // Evolución últimos 6 meses
    const [evolucion] = await query(`
      SELECT 
        YEAR(fecha) as anio,
        MONTH(fecha) as mes,
        SUM(CASE WHEN tipo = 'abono' THEN monto ELSE 0 END) as ingresos,
        SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE 0 END) as gastos
      FROM movimientos
      WHERE fecha >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY YEAR(fecha), MONTH(fecha)
      ORDER BY anio, mes
    `);
    
    res.json({
      mes: mesActual,
      anio: anioActual,
      ingresos,
      gastos,
      saldo,
      gastosCategoria: gastosCategoria.map(g => ({
        ...g,
        total: parseFloat(g.total)
      })),
      evolucion: evolucion.map(e => ({
        ...e,
        ingresos: parseFloat(e.ingresos),
        gastos: parseFloat(e.gastos),
        saldo: parseFloat(e.ingresos) - parseFloat(e.gastos)
      }))
    });
  } catch (error) {
    console.error('Error al obtener resumen:', error);
    res.status(500).json({ error: 'Error al obtener resumen' });
  }
});

// Uso de cupo de tarjetas de crédito
router.get('/tarjetas', async (req, res) => {
  try {
    const [tarjetas] = await query(`
      SELECT id, nombre, cupo_total, dia_facturacion, dia_vencimiento
      FROM cuentas
      WHERE tipo = 'tarjeta_credito' AND activa = true AND cupo_total IS NOT NULL
    `);
    
    const resultado = [];
    
    for (const tarjeta of tarjetas) {
      // Calcular uso del mes actual
      const [uso] = await query(`
        SELECT SUM(monto) as usado
        FROM movimientos
        WHERE cuenta_id = ? 
          AND tipo = 'cargo'
          AND MONTH(fecha) = MONTH(CURRENT_DATE)
          AND YEAR(fecha) = YEAR(CURRENT_DATE)
      `, [tarjeta.id]);
      
      const usado = parseFloat(uso[0].usado) || 0;
      const cupoTotal = parseFloat(tarjeta.cupo_total);
      const disponible = cupoTotal - usado;
      const porcentajeUso = (usado / cupoTotal) * 100;
      
      // Calcular próxima fecha de vencimiento
      let proximoVencimiento = null;
      if (tarjeta.dia_vencimiento) {
        const hoy = new Date();
        proximoVencimiento = new Date(hoy.getFullYear(), hoy.getMonth(), tarjeta.dia_vencimiento);
        
        if (proximoVencimiento < hoy) {
          proximoVencimiento = new Date(hoy.getFullYear(), hoy.getMonth() + 1, tarjeta.dia_vencimiento);
        }
      }
      
      resultado.push({
        ...tarjeta,
        cupo_total: cupoTotal,
        usado,
        disponible,
        porcentajeUso: Math.round(porcentajeUso),
        proximoVencimiento: proximoVencimiento ? proximoVencimiento.toISOString().split('T')[0] : null
      });
    }
    
    res.json(resultado);
  } catch (error) {
    console.error('Error al obtener tarjetas:', error);
    res.status(500).json({ error: 'Error al obtener información de tarjetas' });
  }
});

// Resumen de préstamos pendientes
router.get('/prestamos-pendientes', async (req, res) => {
  try {
    const [movimientos] = await query(`
      SELECT 
        persona_prestamo,
        SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE -monto END) as saldo_movimientos
      FROM movimientos
      WHERE es_prestamo = true AND persona_prestamo IS NOT NULL
      GROUP BY persona_prestamo
    `);
    
    const [pagos] = await query(`
      SELECT 
        persona,
        SUM(monto) as total_pagos
      FROM pagos_prestamos
      GROUP BY persona
    `);
    
    // Combinar saldos
    const resumen = {};
    
    movimientos.forEach(m => {
      resumen[m.persona_prestamo] = {
        persona: m.persona_prestamo,
        saldo: parseFloat(m.saldo_movimientos)
      };
    });
    
    pagos.forEach(p => {
      if (resumen[p.persona]) {
        resumen[p.persona].saldo -= parseFloat(p.total_pagos);
      }
    });
    
    // Filtrar solo pendientes (saldo != 0)
    const pendientes = Object.values(resumen).filter(p => Math.abs(p.saldo) > 0.01);
    
    res.json(pendientes);
  } catch (error) {
    console.error('Error al obtener préstamos pendientes:', error);
    res.status(500).json({ error: 'Error al obtener préstamos pendientes' });
  }
});

// Movimientos recientes
router.get('/recientes', async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 10;
    
    const [movimientos] = await query(`
      SELECT m.*, 
             c.nombre as cuenta_nombre,
             cat.nombre as categoria_nombre,
             cat.color as categoria_color
      FROM movimientos m
      LEFT JOIN cuentas c ON m.cuenta_id = c.id
      LEFT JOIN categorias cat ON m.categoria_id = cat.id
      ORDER BY m.fecha DESC, m.creado_en DESC
      LIMIT ?
    `, [limite]);
    
    res.json(movimientos);
  } catch (error) {
    console.error('Error al obtener movimientos recientes:', error);
    res.status(500).json({ error: 'Error al obtener movimientos recientes' });
  }
});

export default router;
