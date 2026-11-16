import { useState, useEffect } from 'react';
import api from '../utils/api';
import { formatCLP, formatFecha } from '../utils/format';

export default function Prestamos() {
  const [resumen, setResumen] = useState([]);
  const [personaSeleccionada, setPersonaSeleccionada] = useState(null);
  const [movimientos, setMovimientos] = useState([]);
  const [pagos, setPagos] = useState([]);
  const [mostrarModalPago, setMostrarModalPago] = useState(false);
  const [cargando, setCargando] = useState(true);

  const [formPago, setFormPago] = useState({
    persona: '',
    monto: '',
    fecha: new Date().toISOString().split('T')[0],
    notas: ''
  });

  useEffect(() => {
    cargarResumen();
  }, []);

  const cargarResumen = async () => {
    try {
      const response = await api.get('/prestamos/resumen');
      setResumen(response.data);
    } catch (error) {
      console.error('Error al cargar resumen:', error);
    } finally {
      setCargando(false);
    }
  };

  const seleccionarPersona = async (persona) => {
    setPersonaSeleccionada(persona);
    try {
      const [movRes, pagosRes] = await Promise.all([
        api.get(`/prestamos/persona/${encodeURIComponent(persona)}`),
        api.get(`/prestamos/pagos/${encodeURIComponent(persona)}`)
      ]);
      setMovimientos(movRes.data);
      setPagos(pagosRes.data);
    } catch (error) {
      console.error('Error al cargar detalles:', error);
    }
  };

  const abrirModalPago = (persona) => {
    setFormPago({
      persona,
      monto: '',
      fecha: new Date().toISOString().split('T')[0],
      notas: ''
    });
    setMostrarModalPago(true);
  };

  const registrarPago = async (e) => {
    e.preventDefault();
    try {
      await api.post('/prestamos/pagos', formPago);
      setMostrarModalPago(false);
      cargarResumen();
      if (personaSeleccionada) {
        seleccionarPersona(personaSeleccionada);
      }
    } catch (error) {
      console.error('Error al registrar pago:', error);
      alert('Error al registrar el pago');
    }
  };

  if (cargando) {
    return <div className="text-center py-12"><i className="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>;
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Préstamos y Tarjetas Prestadas</h1>

      {resumen.length === 0 ? (
        <div className="card text-center py-12">
          <i className="fas fa-handshake text-6xl text-gray-300 mb-4"></i>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No hay préstamos registrados</h3>
          <p className="text-gray-600">Los movimientos marcados como préstamo aparecerán aquí</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Lista de Personas */}
          <div className="card lg:col-span-1">
            <h2 className="text-lg font-semibold mb-4">Personas</h2>
            <div className="space-y-2">
              {resumen.map((item, idx) => (
                <div
                  key={idx}
                  onClick={() => seleccionarPersona(item.persona)}
                  className={`p-3 rounded-lg cursor-pointer transition-colors ${
                    personaSeleccionada === item.persona
                      ? 'bg-blue-50 border-2 border-blue-500'
                      : 'bg-gray-50 hover:bg-gray-100 border-2 border-transparent'
                  }`}
                >
                  <div className="flex justify-between items-center">
                    <span className="font-medium text-gray-900">{item.persona}</span>
                    <span className={`font-bold ${item.saldo > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {formatCLP(Math.abs(item.saldo))}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 mt-1">
                    {item.saldo > 0 ? 'Te deben' : 'Debes'}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Detalles */}
          <div className="lg:col-span-2">
            {personaSeleccionada ? (
              <div className="space-y-6">
                <div className="card">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="text-lg font-semibold">{personaSeleccionada}</h2>
                    <button
                      onClick={() => abrirModalPago(personaSeleccionada)}
                      className="btn btn-primary text-sm"
                    >
                      <i className="fas fa-plus mr-2"></i>
                      Registrar Pago
                    </button>
                  </div>

                  <div className="mb-6 p-4 bg-blue-50 rounded-lg">
                    <p className="text-sm text-gray-700 mb-1">Saldo Total</p>
                    <p className="text-2xl font-bold text-blue-900">
                      {(() => {
                        const persona = resumen.find(p => p.persona === personaSeleccionada);
                        return persona ? `${persona.saldo > 0 ? 'Te deben' : 'Debes'} ${formatCLP(Math.abs(persona.saldo))}` : '';
                      })()}
                    </p>
                  </div>

                  <h3 className="font-semibold mb-3">Movimientos</h3>
                  {movimientos.length > 0 ? (
                    <div className="space-y-2 mb-6">
                      {movimientos.map(mov => (
                        <div key={mov.id} className="flex justify-between items-center py-2 border-b border-gray-100">
                          <div>
                            <p className="font-medium text-sm">{mov.descripcion}</p>
                            <p className="text-xs text-gray-600">
                              {formatFecha(mov.fecha)} • {mov.cuenta_nombre}
                            </p>
                          </div>
                          <span className={`font-semibold ${mov.tipo === 'cargo' ? 'text-red-600' : 'text-green-600'}`}>
                            {mov.tipo === 'cargo' ? '+' : '-'}{formatCLP(mov.monto)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 mb-6">No hay movimientos</p>
                  )}

                  <h3 className="font-semibold mb-3">Pagos Registrados</h3>
                  {pagos.length > 0 ? (
                    <div className="space-y-2">
                      {pagos.map(pago => (
                        <div key={pago.id} className="flex justify-between items-center py-2 border-b border-gray-100">
                          <div>
                            <p className="text-sm">{pago.notas || 'Pago'}</p>
                            <p className="text-xs text-gray-600">{formatFecha(pago.fecha)}</p>
                          </div>
                          <span className="font-semibold text-green-600">
                            -{formatCLP(pago.monto)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">No hay pagos registrados</p>
                  )}
                </div>
              </div>
            ) : (
              <div className="card text-center py-12">
                <i className="fas fa-hand-pointer text-4xl text-gray-300 mb-3"></i>
                <p className="text-gray-600">Selecciona una persona para ver los detalles</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Registrar Pago */}
      {mostrarModalPago && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-md w-full">
            <div className="p-6">
              <h2 className="text-2xl font-bold mb-6">Registrar Pago</h2>
              <form onSubmit={registrarPago} className="space-y-4">
                <div>
                  <label className="label">Persona</label>
                  <input type="text" value={formPago.persona} readOnly className="input bg-gray-50" />
                </div>
                <div>
                  <label className="label">Monto *</label>
                  <input
                    type="number"
                    value={formPago.monto}
                    onChange={(e) => setFormPago({ ...formPago, monto: e.target.value })}
                    className="input"
                    required
                  />
                </div>
                <div>
                  <label className="label">Fecha *</label>
                  <input
                    type="date"
                    value={formPago.fecha}
                    onChange={(e) => setFormPago({ ...formPago, fecha: e.target.value })}
                    className="input"
                    required
                  />
                </div>
                <div>
                  <label className="label">Notas</label>
                  <textarea
                    value={formPago.notas}
                    onChange={(e) => setFormPago({ ...formPago, notas: e.target.value })}
                    className="input"
                    rows="2"
                  ></textarea>
                </div>
                <div className="flex space-x-3">
                  <button type="submit" className="flex-1 btn btn-primary">
                    <i className="fas fa-save mr-2"></i>
                    Guardar
                  </button>
                  <button type="button" onClick={() => setMostrarModalPago(false)} className="flex-1 btn btn-secondary">
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
