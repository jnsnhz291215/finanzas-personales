import { useState, useEffect } from 'react';
import api from '../utils/api';
import { formatCLP, nombreMes } from '../utils/format';

const FORM_FIJO_VACIO = { nombre: '', monto: '', dia_pago: '', categoria_id: '', cuenta_id: '' };

export default function PlanAhorro() {
  const [datos, setDatos] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  const [formPlan, setFormPlan] = useState({ ingreso_base: '', pct_fijos: 50, pct_libres: 30, pct_ahorro: 20 });
  const [errorPlan, setErrorPlan] = useState('');
  const [guardando, setGuardando] = useState(false);

  const [formFijo, setFormFijo] = useState(FORM_FIJO_VACIO);
  const [fijoEditando, setFijoEditando] = useState(null);
  const [errorFijo, setErrorFijo] = useState('');

  useEffect(() => {
    cargarDatos();
  }, []);

  const aplicarDatos = (respuesta) => {
    setDatos(respuesta);
    setFormPlan({
      ingreso_base: respuesta.plan.ingreso_base ?? '',
      pct_fijos: respuesta.plan.pct_fijos,
      pct_libres: respuesta.plan.pct_libres,
      pct_ahorro: respuesta.plan.pct_ahorro
    });
  };

  const cargarDatos = async () => {
    try {
      const [planRes, categoriasRes, cuentasRes] = await Promise.all([
        api.get('/plan-ahorro'),
        api.get('/categorias'),
        api.get('/cuentas')
      ]);
      aplicarDatos(planRes.data);
      setCategorias(categoriasRes.data);
      setCuentas(cuentasRes.data.filter(c => c.activa));
    } catch (e) {
      console.error('Error al cargar el plan de ahorro:', e);
      setError('No se pudo cargar el plan de ahorro');
    } finally {
      setCargando(false);
    }
  };

  const recargarResumen = async () => {
    const res = await api.get('/plan-ahorro');
    aplicarDatos(res.data);
  };

  const sumaPorcentajes = Number(formPlan.pct_fijos) + Number(formPlan.pct_libres) + Number(formPlan.pct_ahorro);
  const sumaValida = Math.abs(sumaPorcentajes - 100) < 0.000001;

  const guardarPlan = async (e) => {
    e.preventDefault();
    setErrorPlan('');
    if (!sumaValida) {
      setErrorPlan(`Los porcentajes deben sumar 100 (suman ${Math.round(sumaPorcentajes * 100) / 100})`);
      return;
    }
    setGuardando(true);
    try {
      const res = await api.put('/plan-ahorro', formPlan);
      aplicarDatos(res.data);
    } catch (err) {
      setErrorPlan(err.response?.data?.error || 'Error al guardar el plan');
    } finally {
      setGuardando(false);
    }
  };

  const editarFijo = (fijo) => {
    setFijoEditando(fijo.id);
    setFormFijo({
      nombre: fijo.nombre,
      monto: fijo.monto,
      dia_pago: fijo.dia_pago ?? '',
      categoria_id: fijo.categoria_id ?? '',
      cuenta_id: fijo.cuenta_id ?? ''
    });
    setErrorFijo('');
  };

  const cancelarFijo = () => {
    setFijoEditando(null);
    setFormFijo(FORM_FIJO_VACIO);
    setErrorFijo('');
  };

  const guardarFijo = async (e) => {
    e.preventDefault();
    setErrorFijo('');
    try {
      if (fijoEditando) {
        await api.put(`/gastos-fijos/${fijoEditando}`, formFijo);
      } else {
        await api.post('/gastos-fijos', formFijo);
      }
      cancelarFijo();
      await recargarResumen();
    } catch (err) {
      setErrorFijo(err.response?.data?.error || 'Error al guardar el gasto fijo');
    }
  };

  const eliminarFijo = async (fijo) => {
    if (!confirm(`¿Quitar "${fijo.nombre}" de tus gastos fijos?`)) return;
    try {
      await api.delete(`/gastos-fijos/${fijo.id}`);
      await recargarResumen();
    } catch (err) {
      console.error('Error al eliminar el gasto fijo:', err);
    }
  };

  if (cargando) {
    return <div className="text-center py-12"><i className="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>;
  }

  if (!datos) {
    return (
      <div className="text-center py-12">
        <i className="fas fa-exclamation-circle text-4xl text-gray-400 mb-4"></i>
        <p className="text-gray-600">{error || 'No se pudo cargar la información'}</p>
      </div>
    );
  }

  const { resumen, gastosFijos } = datos;
  const usado = Math.min(resumen.libre.porcentajeUsado, 100);
  const colorBarra = resumen.libre.porcentajeUsado > 100
    ? 'bg-red-500'
    : resumen.libre.porcentajeUsado >= 80 ? 'bg-orange-500' : 'bg-blue-600';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">
          <i className="fas fa-piggy-bank mr-3 text-blue-600"></i>
          Plan de ahorro
        </h1>
        <p className="text-gray-600 mt-1">
          {nombreMes(resumen.mes.mes)} {resumen.mes.anio} · quedan {resumen.mes.diasRestantes} días
          {resumen.ingresoOrigen === 'base' ? ' · ingreso base' : ' · ingresos reales del mes'}
        </p>
      </div>

      {/* Alertas */}
      {resumen.alertas.length > 0 && (
        <div className="space-y-2">
          {resumen.alertas.map(a => (
            <div
              key={a.codigo}
              className={`card flex items-center ${a.nivel === 'critica' ? 'bg-red-50 border-red-200 text-red-800' : a.nivel === 'aviso' ? 'bg-orange-50 border-orange-200 text-orange-800' : 'bg-blue-50 border-blue-200 text-blue-800'}`}
            >
              <i className={`fas ${a.nivel === 'info' ? 'fa-circle-info' : 'fa-triangle-exclamation'} mr-3`}></i>
              <span className="text-sm">{a.mensaje}</span>
            </div>
          ))}
        </div>
      )}

      {/* Tarjetas */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="card">
          <p className="text-sm font-medium text-gray-600"><i className="fas fa-wallet mr-2"></i>Ingreso</p>
          <p className="text-xl font-bold text-gray-900 mt-1">{formatCLP(resumen.ingreso)}</p>
        </div>
        <div className="card bg-gradient-to-br from-green-50 to-emerald-50 border-green-200">
          <p className="text-sm font-medium text-green-800"><i className="fas fa-piggy-bank mr-2"></i>Meta de ahorro</p>
          <p className="text-xl font-bold text-green-900 mt-1">{formatCLP(resumen.metaAhorro)}</p>
          <p className="text-xs text-green-700 mt-1">{resumen.porcentajes.ahorro}% del ingreso</p>
        </div>
        <div className="card">
          <p className="text-sm font-medium text-gray-600"><i className="fas fa-receipt mr-2"></i>Gastos fijos</p>
          <p className="text-xl font-bold text-gray-900 mt-1">{formatCLP(resumen.fijos.real)}</p>
          <p className="text-xs text-gray-500 mt-1">
            Presupuesto {resumen.porcentajes.fijos}%: {formatCLP(resumen.fijos.presupuesto)}
          </p>
        </div>
        <div className={`card ${resumen.disponible >= 0 ? 'bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200' : 'bg-gradient-to-br from-orange-50 to-amber-50 border-orange-200'}`}>
          <p className="text-sm font-medium text-gray-800">Disponible para gastar</p>
          <p className={`text-xl font-bold mt-1 ${resumen.disponible >= 0 ? 'text-blue-900' : 'text-orange-900'}`}>
            {formatCLP(resumen.disponible)}
          </p>
        </div>
        <div className="card">
          <p className="text-sm font-medium text-gray-600">Disponible por día</p>
          <p className="text-xl font-bold text-gray-900 mt-1">{formatCLP(resumen.disponiblePorDia)}</p>
          <p className="text-xs text-gray-500 mt-1">{resumen.mes.diasRestantes} días restantes</p>
        </div>
      </div>

      {/* Barra del gasto libre */}
      <div className="card">
        <div className="flex justify-between text-sm mb-2">
          <span className="font-medium text-gray-900">Gasto libre del mes</span>
          <span className="text-gray-600">
            {formatCLP(resumen.libre.gastado)} de {formatCLP(Math.max(resumen.libre.presupuesto, 0))} ({resumen.libre.porcentajeUsado}%)
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-3">
          <div className={`${colorBarra} h-3 rounded-full`} style={{ width: `${usado}%` }}></div>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Presupuesto libre = ingreso − meta de ahorro − gastos fijos. Cuentan compras y transferencias a terceros que no son gastos fijos.
        </p>
      </div>

      {/* Porcentajes e ingreso base */}
      <form onSubmit={guardarPlan} className="card space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Porcentajes e ingreso base</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="label">Ingreso base (opcional)</label>
            <input
              type="number" min="0" className="input" placeholder="Usar ingresos reales"
              value={formPlan.ingreso_base}
              onChange={(e) => setFormPlan({ ...formPlan, ingreso_base: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Fijos (%)</label>
            <input type="number" min="0" max="100" step="any" className="input" value={formPlan.pct_fijos}
              onChange={(e) => setFormPlan({ ...formPlan, pct_fijos: e.target.value })} />
          </div>
          <div>
            <label className="label">Libres (%)</label>
            <input type="number" min="0" max="100" step="any" className="input" value={formPlan.pct_libres}
              onChange={(e) => setFormPlan({ ...formPlan, pct_libres: e.target.value })} />
          </div>
          <div>
            <label className="label">Ahorro (%)</label>
            <input type="number" min="0" max="100" step="any" className="input" value={formPlan.pct_ahorro}
              onChange={(e) => setFormPlan({ ...formPlan, pct_ahorro: e.target.value })} />
          </div>
        </div>
        <p className={`text-sm ${sumaValida ? 'text-gray-600' : 'text-red-600'}`}>
          Suman {Math.round(sumaPorcentajes * 100) / 100}% {sumaValida ? '' : '(deben sumar 100)'}
        </p>
        {errorPlan && <p className="text-sm text-red-600">{errorPlan}</p>}
        <button type="submit" className="btn btn-primary" disabled={guardando || !sumaValida}>
          <i className="fas fa-save mr-2"></i>
          Guardar plan
        </button>
      </form>

      {/* Gastos fijos */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          <i className="fas fa-receipt mr-2"></i>
          Gastos fijos
        </h2>

        {gastosFijos.length === 0 ? (
          <p className="text-gray-600 mb-4">Aún no tienes gastos fijos: arriendo, internet, plan del celular, suscripciones.</p>
        ) : (
          <div className="overflow-x-auto mb-4">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-2 px-3 font-medium text-gray-700">Nombre</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-700">Monto</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700">Día de pago</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700">Categoría</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700">Cuenta</th>
                  <th className="text-right py-2 px-3 font-medium text-gray-700">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {gastosFijos.map(f => (
                  <tr key={f.id} className="border-b border-gray-100">
                    <td className="py-2 px-3 font-medium text-gray-900">{f.nombre}</td>
                    <td className="py-2 px-3 text-right">{formatCLP(f.monto)}</td>
                    <td className="py-2 px-3 text-sm text-gray-600">{f.dia_pago ?? '-'}</td>
                    <td className="py-2 px-3 text-sm text-gray-600">{f.categoria_nombre ?? '-'}</td>
                    <td className="py-2 px-3 text-sm text-gray-600">{f.cuenta_nombre ?? '-'}</td>
                    <td className="py-2 px-3 text-right">
                      <button onClick={() => editarFijo(f)} className="text-blue-600 hover:text-blue-700 mr-3">
                        <i className="fas fa-edit"></i>
                      </button>
                      <button onClick={() => eliminarFijo(f)} className="text-red-600 hover:text-red-700">
                        <i className="fas fa-trash"></i>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form onSubmit={guardarFijo} className="border-t border-gray-200 pt-4 space-y-4">
          <h3 className="font-medium text-gray-900">{fijoEditando ? 'Editar gasto fijo' : 'Agregar gasto fijo'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <label className="label">Nombre *</label>
              <input type="text" className="input" required value={formFijo.nombre}
                onChange={(e) => setFormFijo({ ...formFijo, nombre: e.target.value })} />
            </div>
            <div>
              <label className="label">Monto *</label>
              <input type="number" min="1" className="input" required value={formFijo.monto}
                onChange={(e) => setFormFijo({ ...formFijo, monto: e.target.value })} />
            </div>
            <div>
              <label className="label">Día de pago</label>
              <input type="number" min="1" max="31" className="input" value={formFijo.dia_pago}
                onChange={(e) => setFormFijo({ ...formFijo, dia_pago: e.target.value })} />
            </div>
            <div>
              <label className="label">Categoría</label>
              <select className="input" value={formFijo.categoria_id}
                onChange={(e) => setFormFijo({ ...formFijo, categoria_id: e.target.value })}>
                <option value="">Sin categoría</option>
                {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Cuenta</label>
              <select className="input" value={formFijo.cuenta_id}
                onChange={(e) => setFormFijo({ ...formFijo, cuenta_id: e.target.value })}>
                <option value="">Sin cuenta</option>
                {cuentas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            Un movimiento cuenta como este gasto fijo si tiene su categoría o si su descripción contiene su nombre.
          </p>
          {errorFijo && <p className="text-sm text-red-600">{errorFijo}</p>}
          <div className="flex space-x-3">
            <button type="submit" className="btn btn-primary">
              <i className="fas fa-save mr-2"></i>
              {fijoEditando ? 'Guardar cambios' : 'Agregar'}
            </button>
            {fijoEditando && (
              <button type="button" onClick={cancelarFijo} className="btn btn-secondary">Cancelar</button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
