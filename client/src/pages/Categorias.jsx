import { useState, useEffect } from 'react';
import api from '../utils/api';

export default function Categorias() {
  const [categorias, setCategorias] = useState([]);
  const [reglas, setReglas] = useState([]);
  const [mostrarModalCategoria, setMostrarModalCategoria] = useState(false);
  const [mostrarModalRegla, setMostrarModalRegla] = useState(false);
  const [cargando, setCargando] = useState(true);

  const [formCategoria, setFormCategoria] = useState({ nombre: '', color: '#6B7280', icono: 'fa-folder' });
  const [formRegla, setFormRegla] = useState({ texto_buscar: '', categoria_id: '' });

  useEffect(() => {
    cargarDatos();
  }, []);

  const cargarDatos = async () => {
    try {
      const [catRes, reglasRes] = await Promise.all([
        api.get('/categorias'),
        api.get('/categorias/reglas')
      ]);
      setCategorias(catRes.data);
      setReglas(reglasRes.data);
    } catch (error) {
      console.error('Error al cargar datos:', error);
    } finally {
      setCargando(false);
    }
  };

  const guardarCategoria = async (e) => {
    e.preventDefault();
    try {
      await api.post('/categorias', formCategoria);
      cargarDatos();
      setMostrarModalCategoria(false);
      setFormCategoria({ nombre: '', color: '#6B7280', icono: 'fa-folder' });
    } catch (error) {
      console.error('Error al guardar categoría:', error);
      alert('Error al guardar la categoría');
    }
  };

  const eliminarCategoria = async (id, nombre) => {
    if (!confirm(`¿Eliminar la categoría "${nombre}"?`)) return;
    try {
      await api.delete(`/categorias/${id}`);
      cargarDatos();
    } catch (error) {
      console.error('Error al eliminar:', error);
    }
  };

  const guardarRegla = async (e) => {
    e.preventDefault();
    try {
      await api.post('/categorias/reglas', formRegla);
      cargarDatos();
      setMostrarModalRegla(false);
      setFormRegla({ texto_buscar: '', categoria_id: '' });
    } catch (error) {
      console.error('Error al guardar regla:', error);
      alert('Error al guardar la regla');
    }
  };

  const eliminarRegla = async (id) => {
    if (!confirm('¿Eliminar esta regla?')) return;
    try {
      await api.delete(`/categorias/reglas/${id}`);
      cargarDatos();
    } catch (error) {
      console.error('Error al eliminar:', error);
    }
  };

  const coloresComunes = [
    '#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#8B5CF6',
    '#EC4899', '#14B8A6', '#6366F1', '#F97316', '#22C55E'
  ];

  const iconosComunes = [
    'fa-shopping-cart', 'fa-bus', 'fa-utensils', 'fa-file-invoice-dollar',
    'fa-sync', 'fa-heartbeat', 'fa-film', 'fa-graduation-cap',
    'fa-home', 'fa-car', 'fa-plane', 'fa-shopping-bag', 'fa-coffee'
  ];

  if (cargando) {
    return <div className="text-center py-12"><i className="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>;
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Categorías</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Categorías */}
        <div>
          <div className="card">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Mis Categorías</h2>
              <button onClick={() => setMostrarModalCategoria(true)} className="btn btn-primary text-sm">
                <i className="fas fa-plus mr-2"></i>
                Nueva
              </button>
            </div>
            <div className="space-y-2">
              {categorias.map(cat => (
                <div key={cat.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div className="flex items-center">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center mr-3"
                      style={{ backgroundColor: cat.color + '30' }}
                    >
                      <i className={`fas ${cat.icono} text-sm`} style={{ color: cat.color }}></i>
                    </div>
                    <span className="font-medium">{cat.nombre}</span>
                  </div>
                  <button onClick={() => eliminarCategoria(cat.id, cat.nombre)} className="text-red-600 hover:text-red-700 text-sm">
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Reglas */}
        <div>
          <div className="card">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold">Reglas de Autocategorización</h2>
              <button onClick={() => setMostrarModalRegla(true)} className="btn btn-primary text-sm">
                <i className="fas fa-plus mr-2"></i>
                Nueva Regla
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Las reglas se aplican automáticamente al importar movimientos
            </p>
            <div className="space-y-2">
              {reglas.map(regla => (
                <div key={regla.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">Si contiene: "{regla.texto_buscar}"</p>
                    <p className="text-xs text-gray-600">→ Categoría: {regla.categoria_nombre}</p>
                  </div>
                  <button onClick={() => eliminarRegla(regla.id)} className="text-red-600 hover:text-red-700 text-sm">
                    <i className="fas fa-trash"></i>
                  </button>
                </div>
              ))}
              {reglas.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-4">No hay reglas configuradas</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Modal Categoría */}
      {mostrarModalCategoria && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full">
            <div className="p-6">
              <h2 className="text-2xl font-bold mb-6">Nueva Categoría</h2>
              <form onSubmit={guardarCategoria} className="space-y-4">
                <div>
                  <label className="label">Nombre *</label>
                  <input
                    type="text"
                    value={formCategoria.nombre}
                    onChange={(e) => setFormCategoria({ ...formCategoria, nombre: e.target.value })}
                    className="input"
                    required
                  />
                </div>
                <div>
                  <label className="label">Color</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {coloresComunes.map(color => (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setFormCategoria({ ...formCategoria, color })}
                        className={`w-8 h-8 rounded-full ${formCategoria.color === color ? 'ring-2 ring-offset-2 ring-blue-500' : ''}`}
                        style={{ backgroundColor: color }}
                      ></button>
                    ))}
                  </div>
                  <input
                    type="color"
                    value={formCategoria.color}
                    onChange={(e) => setFormCategoria({ ...formCategoria, color: e.target.value })}
                    className="w-full h-10 cursor-pointer"
                  />
                </div>
                <div>
                  <label className="label">Icono</label>
                  <div className="grid grid-cols-7 gap-2 mb-2">
                    {iconosComunes.map(icono => (
                      <button
                        key={icono}
                        type="button"
                        onClick={() => setFormCategoria({ ...formCategoria, icono })}
                        className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          formCategoria.icono === icono ? 'bg-blue-100 ring-2 ring-blue-500' : 'bg-gray-100 hover:bg-gray-200'
                        }`}
                      >
                        <i className={`fas ${icono}`}></i>
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={formCategoria.icono}
                    onChange={(e) => setFormCategoria({ ...formCategoria, icono: e.target.value })}
                    className="input"
                    placeholder="fa-folder"
                  />
                </div>
                <div className="flex space-x-3">
                  <button type="submit" className="flex-1 btn btn-primary">Crear</button>
                  <button type="button" onClick={() => setMostrarModalCategoria(false)} className="flex-1 btn btn-secondary">
                    Cancelar
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Modal Regla */}
      {mostrarModalRegla && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full">
            <div className="p-6">
              <h2 className="text-2xl font-bold mb-6">Nueva Regla</h2>
              <form onSubmit={guardarRegla} className="space-y-4">
                <div>
                  <label className="label">Texto a buscar *</label>
                  <input
                    type="text"
                    value={formRegla.texto_buscar}
                    onChange={(e) => setFormRegla({ ...formRegla, texto_buscar: e.target.value })}
                    className="input"
                    placeholder="Ej: supermercado, uber, netflix"
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">Se busca en la descripción del movimiento</p>
                </div>
                <div>
                  <label className="label">Categoría *</label>
                  <select
                    value={formRegla.categoria_id}
                    onChange={(e) => setFormRegla({ ...formRegla, categoria_id: e.target.value })}
                    className="input"
                    required
                  >
                    <option value="">Seleccionar...</option>
                    {categorias.map(cat => (
                      <option key={cat.id} value={cat.id}>{cat.nombre}</option>
                    ))}
                  </select>
                </div>
                <div className="flex space-x-3">
                  <button type="submit" className="flex-1 btn btn-primary">Crear</button>
                  <button type="button" onClick={() => setMostrarModalRegla(false)} className="flex-1 btn btn-secondary">
                    Cancelar
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
