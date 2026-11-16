import { useState, useEffect } from 'react';
import api from '../utils/api';
import { formatCLP } from '../utils/format';

export default function Cuentas() {
  const [cuentas, setCuentas] = useState([]);
  const [mostrarModal, setMostrarModal] = useState(false);
  const [cuentaEditando, setCuentaEditando] = useState(null);
  const [cargando, setCargando] = useState(true);

  const [formData, setFormData] = useState({
    nombre: '',
    tipo: 'cuenta_corriente',
    banco: '',
    numero_cuenta: '',
    cupo_total: '',
    dia_facturacion: '',
    dia_vencimiento: '',
    notas: '',
    activa: true
  });

  useEffect(() => {
    cargarCuentas();
  }, []);

  const cargarCuentas = async () => {
    try {
      const response = await api.get('/cuentas');
      setCuentas(response.data);
    } catch (error) {
      console.error('Error al cargar cuentas:', error);
    } finally {
      setCargando(false);
    }
  };

  const abrirModal = (cuenta = null) => {
    if (cuenta) {
      setCuentaEditando(cuenta);
      setFormData({
        nombre: cuenta.nombre || '',
        tipo: cuenta.tipo || 'cuenta_corriente',
        banco: cuenta.banco || '',
        numero_cuenta: cuenta.numero_cuenta || '',
        cupo_total: cuenta.cupo_total || '',
        dia_facturacion: cuenta.dia_facturacion || '',
        dia_vencimiento: cuenta.dia_vencimiento || '',
        notas: cuenta.notas || '',
        activa: cuenta.activa !== undefined ? cuenta.activa : true
      });
    } else {
      setCuentaEditando(null);
      setFormData({
        nombre: '',
        tipo: 'cuenta_corriente',
        banco: '',
        numero_cuenta: '',
        cupo_total: '',
        dia_facturacion: '',
        dia_vencimiento: '',
        notas: '',
        activa: true
      });
    }
    setMostrarModal(true);
  };

  const cerrarModal = () => {
    setMostrarModal(false);
    setCuentaEditando(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    try {
      if (cuentaEditando) {
        await api.put(`/cuentas/${cuentaEditando.id}`, formData);
      } else {
        await api.post('/cuentas', formData);
      }
      cargarCuentas();
      cerrarModal();
    } catch (error) {
      console.error('Error al guardar cuenta:', error);
      alert('Error al guardar la cuenta');
    }
  };

  const eliminarCuenta = async (id, nombre) => {
    if (!confirm(`¿Estás seguro de eliminar la cuenta "${nombre}"? Se eliminarán todos sus movimientos.`)) {
      return;
    }

    try {
      await api.delete(`/cuentas/${id}`);
      cargarCuentas();
    } catch (error) {
      console.error('Error al eliminar cuenta:', error);
      alert('Error al eliminar la cuenta');
    }
  };

  const tiposCuenta = [
    { value: 'cuenta_corriente', label: 'Cuenta Corriente', icon: 'fa-university' },
    { value: 'cuenta_vista', label: 'Cuenta Vista', icon: 'fa-eye' },
    { value: 'cuenta_ahorro', label: 'Cuenta de Ahorro', icon: 'fa-piggy-bank' },
    { value: 'tarjeta_credito', label: 'Tarjeta de Crédito', icon: 'fa-credit-card' },
    { value: 'tarjeta_debito', label: 'Tarjeta de Débito', icon: 'fa-credit-card' }
  ];

  const getIconoTipo = (tipo) => {
    const tipoObj = tiposCuenta.find(t => t.value === tipo);
    return tipoObj?.icon || 'fa-wallet';
  };

  if (cargando) {
    return <div className="text-center py-12"><i className="fas fa-spinner fa-spin text-4xl text-blue-600"></i></div>;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Cuentas y Tarjetas</h1>
        <button onClick={() => abrirModal()} className="btn btn-primary">
          <i className="fas fa-plus mr-2"></i>
          Nueva Cuenta
        </button>
      </div>

      {cuentas.length === 0 ? (
        <div className="card text-center py-12">
          <i className="fas fa-credit-card text-6xl text-gray-300 mb-4"></i>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No hay cuentas registradas</h3>
          <p className="text-gray-600 mb-4">Comienza agregando tu primera cuenta o tarjeta</p>
          <button onClick={() => abrirModal()} className="btn btn-primary">
            <i className="fas fa-plus mr-2"></i>
            Agregar Cuenta
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {cuentas.map(cuenta => (
            <div key={cuenta.id} className={`card ${!cuenta.activa ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center mr-3">
                    <i className={`fas ${getIconoTipo(cuenta.tipo)} text-blue-600`}></i>
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-900">{cuenta.nombre}</h3>
                    <p className="text-sm text-gray-600">
                      {tiposCuenta.find(t => t.value === cuenta.tipo)?.label || cuenta.tipo}
                    </p>
                  </div>
                </div>
                {!cuenta.activa && (
                  <span className="badge bg-gray-200 text-gray-700">Inactiva</span>
                )}
              </div>

              {cuenta.banco && (
                <p className="text-sm text-gray-600 mb-1">
                  <i className="fas fa-building mr-2"></i>
                  {cuenta.banco}
                </p>
              )}

              {cuenta.cupo_total && (
                <p className="text-sm text-gray-600 mb-1">
                  <i className="fas fa-credit-card mr-2"></i>
                  Cupo: {formatCLP(cuenta.cupo_total)}
                </p>
              )}

              {cuenta.dia_facturacion && (
                <p className="text-sm text-gray-600 mb-1">
                  <i className="fas fa-calendar mr-2"></i>
                  Facturación: día {cuenta.dia_facturacion}
                </p>
              )}

              {cuenta.dia_vencimiento && (
                <p className="text-sm text-gray-600 mb-1">
                  <i className="fas fa-calendar-check mr-2"></i>
                  Vencimiento: día {cuenta.dia_vencimiento}
                </p>
              )}

              <div className="mt-4 flex space-x-2">
                <button
                  onClick={() => abrirModal(cuenta)}
                  className="flex-1 btn btn-secondary text-sm py-2"
                >
                  <i className="fas fa-edit mr-1"></i>
                  Editar
                </button>
                <button
                  onClick={() => eliminarCuenta(cuenta.id, cuenta.nombre)}
                  className="btn btn-danger text-sm py-2"
                >
                  <i className="fas fa-trash"></i>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {mostrarModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-6">
                {cuentaEditando ? 'Editar Cuenta' : 'Nueva Cuenta'}
              </h2>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="label">Nombre de la Cuenta *</label>
                  <input
                    type="text"
                    value={formData.nombre}
                    onChange={(e) => setFormData({ ...formData, nombre: e.target.value })}
                    className="input"
                    placeholder="Ej: Cuenta FAN Banco de Chile"
                    required
                  />
                </div>

                <div>
                  <label className="label">Tipo *</label>
                  <select
                    value={formData.tipo}
                    onChange={(e) => setFormData({ ...formData, tipo: e.target.value })}
                    className="input"
                    required
                  >
                    {tiposCuenta.map(tipo => (
                      <option key={tipo.value} value={tipo.value}>{tipo.label}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="label">Banco</label>
                    <input
                      type="text"
                      value={formData.banco}
                      onChange={(e) => setFormData({ ...formData, banco: e.target.value })}
                      className="input"
                      placeholder="Ej: Banco de Chile"
                    />
                  </div>

                  <div>
                    <label className="label">Número de Cuenta</label>
                    <input
                      type="text"
                      value={formData.numero_cuenta}
                      onChange={(e) => setFormData({ ...formData, numero_cuenta: e.target.value })}
                      className="input"
                      placeholder="Últimos 4 dígitos"
                    />
                  </div>
                </div>

                {formData.tipo === 'tarjeta_credito' && (
                  <>
                    <div>
                      <label className="label">Cupo Total</label>
                      <input
                        type="number"
                        value={formData.cupo_total}
                        onChange={(e) => setFormData({ ...formData, cupo_total: e.target.value })}
                        className="input"
                        placeholder="500000"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="label">Día de Facturación</label>
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={formData.dia_facturacion}
                          onChange={(e) => setFormData({ ...formData, dia_facturacion: e.target.value })}
                          className="input"
                          placeholder="15"
                        />
                      </div>

                      <div>
                        <label className="label">Día de Vencimiento</label>
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={formData.dia_vencimiento}
                          onChange={(e) => setFormData({ ...formData, dia_vencimiento: e.target.value })}
                          className="input"
                          placeholder="5"
                        />
                      </div>
                    </div>
                  </>
                )}

                <div>
                  <label className="label">Notas</label>
                  <textarea
                    value={formData.notas}
                    onChange={(e) => setFormData({ ...formData, notas: e.target.value })}
                    className="input"
                    rows="3"
                    placeholder="Información adicional..."
                  ></textarea>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="activa"
                    checked={formData.activa}
                    onChange={(e) => setFormData({ ...formData, activa: e.target.checked })}
                    className="mr-2"
                  />
                  <label htmlFor="activa" className="text-sm text-gray-700">Cuenta activa</label>
                </div>

                <div className="flex space-x-3 pt-4">
                  <button type="submit" className="flex-1 btn btn-primary">
                    <i className="fas fa-save mr-2"></i>
                    {cuentaEditando ? 'Actualizar' : 'Crear Cuenta'}
                  </button>
                  <button type="button" onClick={cerrarModal} className="flex-1 btn btn-secondary">
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
