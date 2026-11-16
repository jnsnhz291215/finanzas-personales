import { useState, useEffect } from 'react';
import api from '../utils/api';
import { formatCLP, formatFecha, mesAnioActual } from '../utils/format';

export default function Movimientos() {
  const [movimientos, setMovimientos] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [filtros, setFiltros] = useState({ mes: mesAnioActual().mes, anio: mesAnioActual().anio, cuenta_id: '', categoria_id: '' });
  const [mostrarModal, setMostrarModal] = useState(false);
  const [movimientoEditando, setMovimientoEditando] = useState(null);
  const [cargando, setCargando] = useState(true);

  const [formData, setFormData] = useState({
    cuenta_id: '',
    fecha: new Date().toISOString().split('T')[0],
    descripcion: '',
    monto: '',
    tipo: 'cargo',
    categoria_id: '',
    es_prestamo: false,
    persona_prestamo: '',
    notas: ''
  });

  useEffect(() => {
    cargarDatos();
  }, [filtros]);

  const cargarDatos = async () => {
    try {
      const [movRes, cuentasRes, categoriasRes] = await Promise.all([
        api.get('/movimientos', { params: filtros }),
        api.get('/cuentas'),
        api.get('/categorias')
      ]);
      setMovimientos(movRes.data);
      setCuentas(cuentasRes.data);
      setCategorias(categoriasRes.data);
    } catch (error) {
      console.error('Error al cargar datos:', error);
    } finally {
      setCargando(false);
    }
  };

  const abrirModal = (movimiento = null) => {
    if (movimiento) {
      setMovimientoEditando(movimiento);
      setFormData({
        cuenta_id: movimiento.cuenta_id,
        fecha: movimiento.fecha,
        descripcion: movimiento.descripcion,
        monto: movimiento.monto,
        tipo: movimiento.tipo,
        categoria_id: movimiento.categoria_id || '',
        es_prestamo: movimiento.es_prestamo || false,
        persona_prestamo: movimiento.persona_prestamo || '',
        notas: movimiento.notas || ''
      });
    } else {
      setMovimientoEditando(null);
      setFormData({
        cuenta_id: cuentas[0]?.id || '',
        fecha: new Date().toISOString().split('T')[0],
        descripcion: '',
        monto: '',
        tipo: 'cargo',
        categoria_id: '',
        es_prestamo: false,
        persona_prestamo: '',
        notas: ''
      });
    }
    setMostrarModal(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (movimientoEditando) {
        await api.put(`/movimientos/${movimientoEditando.id}`, formData);
      } else {
        await api.post('/movimientos', formData);
      }
      cargarDatos();
      setMostrarModal(false);
    } catch (error) {
      console.error('Error al guardar movimiento:', error);
      alert('Error al guardar el movimiento');
    }
  };

  const eliminarMovimiento = async (id) => {
    if (!confirm('¿Eliminar este movimiento?')) return;
    try {
      await api.delete(`/movimientos/${id}`);
      cargarDatos();
    } catch (error) {
      console.error('Error al eliminar:', error);
    }
  };

  if (cargando) {
    return <div className="text-center py-12"><i className="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Movimientos</h1>
        <button onClick={() => abrirModal()} className="btn btn-primary">
          <i className="fas fa-plus mr-2"></i>
          Nuevo Movimiento
        </button>
      </div>

      {/* Filtros */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="label">Mes</label>
            <select value={filtros.mes} onChange={(e) => setFiltros({ ...filtros, mes: e.target.value })} className="input">
              {Array.from({length: 12}, (_, i) => i + 1).map(m => (
                <option key={m} value={m}>
                  {new Date(2024, m - 1).toLocaleDateString('es-CL', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Año</label>
            <select value={filtros.anio} onChange={(e) => setFiltros({ ...filtros, anio: e.target.value })} className="input">
              {Array.from({length: 5}, (_, i) => new Date().getFullYear() - i).map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Cuenta</label>
            <select value={filtros.cuenta_id} onChange={(e) => setFiltros({ ...filtros, cuenta_id: e.target.value })} className="input">
              <option value="">Todas</option>
              {cuentas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Categoría</label>
            <select value={filtros.categoria_id} onChange={(e) => setFiltros({ ...filtros, categoria_id: e.target.value })} className="input">
              <option value="">Todas</option>
              {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Lista */}
      {movimientos.length === 0 ? (
        <div className="card text-center py-12">
          <i className="fas fa-list text-6xl text-gray-300 mb-4"></i>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No hay movimientos</h3>
          <p className="text-gray-600">Agrega tu primer movimiento o importa una cartola</p>
        </div>
      ) : (
        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 font-medium text-gray-700">Fecha</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-700">Descripción</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-700">Cuenta</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-700">Categoría</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-700">Monto</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-700">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {movimientos.map(mov => (
                  <tr key={mov.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm">{formatFecha(mov.fecha)}</td>
                    <td className="py-3 px-4">
                      <div className="font-medium text-gray-900">{mov.descripcion}</div>
                      {mov.es_prestamo && (
                        <span className="text-xs text-purple-600">
                          <i className="fas fa-handshake mr-1"></i>
                          {mov.persona_prestamo}
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600">{mov.cuenta_nombre}</td>
                    <td className="py-3 px-4">
                      {mov.categoria_nombre ? (
                        <span className="badge" style={{ backgroundColor: mov.categoria_color + '20', color: mov.categoria_color }}>
                          {mov.categoria_nombre}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Sin categoría</span>
                      )}
                    </td>
                    <td className={`py-3 px-4 text-right font-semibold ${mov.tipo === 'cargo' ? 'text-red-600' : 'text-green-600'}`}>
                      {mov.tipo === 'cargo' ? '-' : '+'}{formatCLP(mov.monto)}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button onClick={() => abrirModal(mov)} className="text-blue-600 hover:text-blue-700 mr-3">
                        <i className="fas fa-edit"></i>
                      </button>
                      <button onClick={() => eliminarMovimiento(mov.id)} className="text-red-600 hover:text-red-700">
                        <i className="fas fa-trash"></i>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modal */}
      {mostrarModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-2xl font-bold mb-6">{movimientoEditando ? 'Editar Movimiento' : 'Nuevo Movimiento'}</h2>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Cuenta *</label>
                    <select value={formData.cuenta_id} onChange={(e) => setFormData({ ...formData, cuenta_id: e.target.value })} className="input" required>
                      <option value="">Seleccionar...</option>
                      {cuentas.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Fecha *</label>
                    <input type="date" value={formData.fecha} onChange={(e) => setFormData({ ...formData, fecha: e.target.value })} className="input" required />
                  </div>
                </div>
                <div>
                  <label className="label">Descripción *</label>
                  <input type="text" value={formData.descripcion} onChange={(e) => setFormData({ ...formData, descripcion: e.target.value })} className="input" required />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Monto *</label>
                    <input type="number" value={formData.monto} onChange={(e) => setFormData({ ...formData, monto: e.target.value })} className="input" required />
                  </div>
                  <div>
                    <label className="label">Tipo *</label>
                    <select value={formData.tipo} onChange={(e) => setFormData({ ...formData, tipo: e.target.value })} className="input">
                      <option value="cargo">Cargo</option>
                      <option value="abono">Abono</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">Categoría</label>
                  <select value={formData.categoria_id} onChange={(e) => setFormData({ ...formData, categoria_id: e.target.value })} className="input">
                    <option value="">Sin categoría</option>
                    {categorias.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                  </select>
                </div>
                <div className="flex items-center">
                  <input type="checkbox" checked={formData.es_prestamo} onChange={(e) => setFormData({ ...formData, es_prestamo: e.target.checked })} className="mr-2" />
                  <label className="text-sm">Es préstamo / tarjeta prestada</label>
                </div>
                {formData.es_prestamo && (
                  <div>
                    <label className="label">Persona</label>
                    <input type="text" value={formData.persona_prestamo} onChange={(e) => setFormData({ ...formData, persona_prestamo: e.target.value })} className="input" placeholder="Nombre de la persona" />
                  </div>
                )}
                <div>
                  <label className="label">Notas</label>
                  <textarea value={formData.notas} onChange={(e) => setFormData({ ...formData, notas: e.target.value })} className="input" rows="2"></textarea>
                </div>
                <div className="flex space-x-3">
                  <button type="submit" className="flex-1 btn btn-primary">
                    <i className="fas fa-save mr-2"></i>
                    Guardar
                  </button>
                  <button type="button" onClick={() => setMostrarModal(false)} className="flex-1 btn btn-secondary">Cancelar</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
