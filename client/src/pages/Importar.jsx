import { useState, useEffect } from 'react';
import api from '../utils/api';
import { formatCLP, formatFecha } from '../utils/format';

export default function Importar() {
  const [cuentas, setCuentas] = useState([]);
  const [cuentaSeleccionada, setCuentaSeleccionada] = useState('');
  const [archivo, setArchivo] = useState(null);
  const [preview, setPreview] = useState(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    cargarCuentas();
  }, []);

  const cargarCuentas = async () => {
    try {
      const response = await api.get('/cuentas');
      setCuentas(response.data);
    } catch (error) {
      console.error('Error al cargar cuentas:', error);
    }
  };

  const handleArchivo = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setArchivo(file);
    setCargando(true);

    const formData = new FormData();
    formData.append('archivo', file);

    try {
      const response = await api.post('/importar/preview', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setPreview(response.data);
    } catch (error) {
      console.error('Error al previsualizar:', error);
      alert('Error al procesar el archivo: ' + (error.response?.data?.error || error.message));
      setArchivo(null);
    } finally {
      setCargando(false);
    }
  };

  const confirmarImportacion = async () => {
    if (!cuentaSeleccionada) {
      alert('Selecciona una cuenta');
      return;
    }

    setCargando(true);

    try {
      const response = await api.post('/importar/confirmar', {
        archivo: preview.archivo,
        hash: preview.hash,
        cuenta_id: cuentaSeleccionada,
        movimientos: preview.movimientos
      });

      alert(response.data.mensaje);
      setArchivo(null);
      setPreview(null);
      setCuentaSeleccionada('');
    } catch (error) {
      console.error('Error al importar:', error);
      alert('Error al importar: ' + (error.response?.data?.error || error.message));
    } finally {
      setCargando(false);
    }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-6">Importar Cartola</h1>

      <div className="card mb-6">
        <h2 className="text-lg font-semibold mb-4">
          <i className="fas fa-info-circle mr-2 text-blue-600"></i>
          Formatos Soportados
        </h2>
        <ul className="space-y-2 text-sm text-gray-700">
          <li><i className="fas fa-check text-green-600 mr-2"></i>CSV de Banco de Chile (columnas: fecha, descripción, cargo, abono)</li>
          <li><i className="fas fa-check text-green-600 mr-2"></i>CSV/Excel de Banco Falabella / CMR (columnas: fecha, establecimiento, monto)</li>
          <li><i className="fas fa-check text-green-600 mr-2"></i>CSV/Excel genérico con fecha, descripción y monto</li>
          <li><i className="fas fa-check text-green-600 mr-2"></i>PDF (extracción básica de texto)</li>
        </ul>
      </div>

      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <div>
            <label className="label">Cuenta *</label>
            <select
              value={cuentaSeleccionada}
              onChange={(e) => setCuentaSeleccionada(e.target.value)}
              className="input"
              required
            >
              <option value="">Seleccionar cuenta...</option>
              {cuentas.map(c => (
                <option key={c.id} value={c.id}>{c.nombre}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Archivo *</label>
            <input
              type="file"
              accept=".csv,.xlsx,.xls,.pdf"
              onChange={handleArchivo}
              className="input"
              disabled={cargando}
            />
          </div>
        </div>

        {cargando && (
          <div className="text-center py-8">
            <i className="fas fa-spinner fa-spin text-4xl text-blue-600 mb-4"></i>
            <p className="text-gray-600">Procesando archivo...</p>
          </div>
        )}

        {preview && (
          <div className="border-t pt-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold mb-2">Vista Previa</h3>
              <div className="flex flex-wrap gap-2 text-sm">
                <span className="badge bg-blue-100 text-blue-800">
                  Archivo: {preview.nombreOriginal}
                </span>
                <span className="badge bg-green-100 text-green-800">
                  Formato: {preview.formato}
                </span>
                <span className="badge bg-purple-100 text-purple-800">
                  {preview.movimientosDetectados} movimientos
                </span>
                {preview.yaImportado && (
                  <span className="badge bg-red-100 text-red-800">
                    <i className="fas fa-exclamation-triangle mr-1"></i>
                    Ya importado
                  </span>
                )}
              </div>
            </div>

            {preview.movimientosDetectados > 0 ? (
              <>
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 px-2">Fecha</th>
                        <th className="text-left py-2 px-2">Descripción</th>
                        <th className="text-right py-2 px-2">Monto</th>
                        <th className="text-center py-2 px-2">Tipo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.movimientos.slice(0, 20).map((mov, idx) => (
                        <tr key={idx} className="border-b border-gray-100">
                          <td className="py-2 px-2">{formatFecha(mov.fecha)}</td>
                          <td className="py-2 px-2">{mov.descripcion}</td>
                          <td className="py-2 px-2 text-right">{formatCLP(mov.monto)}</td>
                          <td className="py-2 px-2 text-center">
                            <span className={`badge ${mov.tipo === 'cargo' ? 'badge-cargo' : 'badge-abono'}`}>
                              {mov.tipo}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.movimientosDetectados > 20 && (
                    <p className="text-xs text-gray-500 mt-2">
                      Mostrando 20 de {preview.movimientosDetectados} movimientos
                    </p>
                  )}
                </div>

                <button
                  onClick={confirmarImportacion}
                  disabled={cargando || preview.yaImportado || !cuentaSeleccionada}
                  className="w-full btn btn-success"
                >
                  <i className="fas fa-check mr-2"></i>
                  Confirmar e Importar
                </button>
              </>
            ) : (
              <div className="text-center py-8 text-gray-500">
                <i className="fas fa-exclamation-circle text-4xl mb-3"></i>
                <p>No se pudieron detectar movimientos automáticamente.</p>
                <p className="text-sm mt-2">Verifica que el formato del archivo sea compatible.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
