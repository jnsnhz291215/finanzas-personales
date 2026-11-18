import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';
import { formatCLP, formatFecha, nombreMes, mesAnioActual } from '../utils/format';
import { tipoEfectivo, infoTipo, estiloMonto } from '../utils/tiposMovimiento';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title } from 'chart.js';
import { Pie, Bar } from 'react-chartjs-2';

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, Title);

export default function Dashboard() {
  const [resumen, setResumen] = useState(null);
  const [tarjetas, setTarjetas] = useState([]);
  const [prestamos, setPrestamos] = useState([]);
  const [recientes, setRecientes] = useState([]);
  const [cargando, setCargando] = useState(true);
  const { mes, anio } = mesAnioActual();

  useEffect(() => {
    cargarDatos();
  }, []);

  const cargarDatos = async () => {
    try {
      const [resumenRes, tarjetasRes, prestamosRes, recientesRes] = await Promise.all([
        api.get(`/dashboard/resumen?mes=${mes}&anio=${anio}`),
        api.get('/dashboard/tarjetas'),
        api.get('/dashboard/prestamos-pendientes'),
        api.get('/dashboard/recientes?limite=8')
      ]);

      setResumen(resumenRes.data);
      setTarjetas(tarjetasRes.data);
      setPrestamos(prestamosRes.data);
      setRecientes(recientesRes.data);
    } catch (error) {
      console.error('Error al cargar dashboard:', error);
    } finally {
      setCargando(false);
    }
  };

  if (cargando) {
    return (
      <div className="text-center py-12">
        <i className="fas fa-spinner fa-spin text-4xl text-blue-600 mb-4"></i>
        <p className="text-gray-600">Cargando panel...</p>
      </div>
    );
  }

  if (!resumen) {
    return (
      <div className="text-center py-12">
        <i className="fas fa-exclamation-circle text-4xl text-gray-400 mb-4"></i>
        <p className="text-gray-600">No se pudo cargar la información</p>
      </div>
    );
  }

  // Datos para gráfico de categorías
  const categoriasData = {
    labels: resumen.gastosCategoria.map(c => c.nombre),
    datasets: [{
      data: resumen.gastosCategoria.map(c => c.total),
      backgroundColor: resumen.gastosCategoria.map(c => c.color),
      borderWidth: 1,
      borderColor: '#fff'
    }]
  };

  // Datos para gráfico de evolución
  const evolucionData = {
    labels: resumen.evolucion.map(e => nombreMes(e.mes)),
    datasets: [
      {
        label: 'Ingresos',
        data: resumen.evolucion.map(e => e.ingresos),
        backgroundColor: '#10B981',
      },
      {
        label: 'Gastos',
        data: resumen.evolucion.map(e => e.gastos),
        backgroundColor: '#EF4444',
      }
    ]
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Panel Principal</h1>
        <p className="text-gray-600 mt-1">{nombreMes(mes)} {anio}</p>
      </div>

      {/* Resumen de Ingresos/Gastos */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="card bg-gradient-to-br from-green-50 to-emerald-50 border-green-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-green-800">Ingresos</p>
              <p className="text-2xl font-bold text-green-900 mt-1">{formatCLP(resumen.ingresos)}</p>
            </div>
            <div className="w-12 h-12 bg-green-200 rounded-full flex items-center justify-center">
              <i className="fas fa-arrow-down text-green-700 text-xl"></i>
            </div>
          </div>
        </div>

        <div className="card bg-gradient-to-br from-red-50 to-rose-50 border-red-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-red-800">Gastos</p>
              <p className="text-2xl font-bold text-red-900 mt-1">{formatCLP(resumen.gastos)}</p>
            </div>
            <div className="w-12 h-12 bg-red-200 rounded-full flex items-center justify-center">
              <i className="fas fa-arrow-up text-red-700 text-xl"></i>
            </div>
          </div>
        </div>

        <div className={`card ${resumen.saldo >= 0 ? 'bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200' : 'bg-gradient-to-br from-orange-50 to-amber-50 border-orange-200'}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Saldo</p>
              <p className={`text-2xl font-bold mt-1 ${resumen.saldo >= 0 ? 'text-blue-900' : 'text-orange-900'}`}>
                {formatCLP(resumen.saldo)}
              </p>
            </div>
            <div className={`w-12 h-12 ${resumen.saldo >= 0 ? 'bg-blue-200' : 'bg-orange-200'} rounded-full flex items-center justify-center`}>
              <i className={`fas ${resumen.saldo >= 0 ? 'fa-check' : 'fa-exclamation'} ${resumen.saldo >= 0 ? 'text-blue-700' : 'text-orange-700'} text-xl`}></i>
            </div>
          </div>
        </div>
      </div>

      {/* Gráficos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Gastos por Categoría */}
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Gastos por Categoría</h2>
          {resumen.gastosCategoria.length > 0 ? (
            <div className="h-64">
              <Pie
                data={categoriasData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: 'right',
                      labels: {
                        boxWidth: 12,
                        font: { size: 11 }
                      }
                    },
                    tooltip: {
                      callbacks: {
                        label: (context) => {
                          const value = context.parsed;
                          return `${context.label}: ${formatCLP(value)}`;
                        }
                      }
                    }
                  }
                }}
              />
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <i className="fas fa-chart-pie text-4xl mb-3"></i>
              <p>No hay gastos registrados</p>
            </div>
          )}
        </div>

        {/* Evolución Últimos Meses */}
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Evolución Últimos Meses</h2>
          {resumen.evolucion.length > 0 ? (
            <div className="h-64">
              <Bar
                data={evolucionData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: 'top',
                    },
                    tooltip: {
                      callbacks: {
                        label: (context) => {
                          return `${context.dataset.label}: ${formatCLP(context.parsed.y)}`;
                        }
                      }
                    }
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                      ticks: {
                        callback: (value) => formatCLP(value)
                      }
                    }
                  }
                }}
              />
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500">
              <i className="fas fa-chart-bar text-4xl mb-3"></i>
              <p>No hay datos históricos</p>
            </div>
          )}
        </div>
      </div>

      {/* Tarjetas de Crédito */}
      {tarjetas.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            <i className="fas fa-credit-card mr-2"></i>
            Uso de Tarjetas de Crédito
          </h2>
          <div className="space-y-4">
            {tarjetas.map(tarjeta => (
              <div key={tarjeta.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h3 className="font-medium text-gray-900">{tarjeta.nombre}</h3>
                    {tarjeta.proximoVencimiento && (
                      <p className="text-sm text-gray-600 mt-1">
                        <i className="fas fa-calendar mr-1"></i>
                        Vencimiento: {new Date(tarjeta.proximoVencimiento).toLocaleDateString('es-CL')}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-gray-600">Usado</p>
                    <p className="font-bold text-lg">{formatCLP(tarjeta.usado)}</p>
                  </div>
                </div>
                <div className="mb-2">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-gray-600">Cupo disponible: {formatCLP(tarjeta.disponible)}</span>
                    <span className="font-medium">{tarjeta.porcentajeUso}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${
                        tarjeta.porcentajeUso >= 80 ? 'bg-red-600' :
                        tarjeta.porcentajeUso >= 60 ? 'bg-yellow-500' :
                        'bg-green-600'
                      }`}
                      style={{ width: `${Math.min(tarjeta.porcentajeUso, 100)}%` }}
                    ></div>
                  </div>
                </div>
                <p className="text-xs text-gray-500">Cupo total: {formatCLP(tarjeta.cupo_total)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Préstamos Pendientes */}
      {prestamos.length > 0 && (
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              <i className="fas fa-handshake mr-2"></i>
              Deudas Pendientes
            </h2>
            <Link to="/prestamos" className="text-sm text-blue-600 hover:text-blue-700">
              Ver detalles <i className="fas fa-arrow-right ml-1"></i>
            </Link>
          </div>
          <div className="space-y-2">
            {prestamos.map((prestamo, idx) => (
              <div key={idx} className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                <span className="text-gray-900">{prestamo.persona}</span>
                <span className={`font-semibold ${prestamo.saldo > 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {prestamo.saldo > 0 ? 'Te deben' : 'Debes'} {formatCLP(Math.abs(prestamo.saldo))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Movimientos Recientes */}
      {recientes.length > 0 && (
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              <i className="fas fa-clock-rotate-left mr-2"></i>
              Movimientos Recientes
            </h2>
            <Link to="/movimientos" className="text-sm text-blue-600 hover:text-blue-700">
              Ver todos <i className="fas fa-arrow-right ml-1"></i>
            </Link>
          </div>
          <div className="space-y-2">
            {recientes.map(mov => {
              const tipoMov = infoTipo(tipoEfectivo(mov));
              const monto = estiloMonto(mov);
              return (
                <div key={mov.id} className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0">
                  <div className="flex items-center min-w-0">
                    <i className={`fas ${tipoMov.icon} ${tipoMov.color} w-6 text-center mr-3`} title={tipoMov.label}></i>
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{mov.descripcion}</div>
                      <div className="text-xs text-gray-500">
                        {formatFecha(mov.fecha)} · {mov.cuenta_nombre}
                        {mov.cuenta_destino_nombre && (
                          <span className="text-blue-600">
                            <i className="fas fa-arrow-right mx-1"></i>
                            {mov.cuenta_destino_nombre}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className={`font-semibold ml-4 whitespace-nowrap ${monto.clase}`}>
                    {monto.signo}{formatCLP(mov.monto)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Acciones Rápidas */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Link to="/movimientos" className="card hover:shadow-md transition-shadow cursor-pointer">
          <div className="text-center">
            <i className="fas fa-plus-circle text-3xl text-blue-600 mb-2"></i>
            <h3 className="font-medium text-gray-900">Agregar Movimiento</h3>
            <p className="text-sm text-gray-600 mt-1">Registrar un cargo o abono</p>
          </div>
        </Link>

        <Link to="/importar" className="card hover:shadow-md transition-shadow cursor-pointer">
          <div className="text-center">
            <i className="fas fa-file-import text-3xl text-green-600 mb-2"></i>
            <h3 className="font-medium text-gray-900">Importar Cartola</h3>
            <p className="text-sm text-gray-600 mt-1">Subir archivo de banco</p>
          </div>
        </Link>

        <Link to="/cuentas" className="card hover:shadow-md transition-shadow cursor-pointer">
          <div className="text-center">
            <i className="fas fa-credit-card text-3xl text-purple-600 mb-2"></i>
            <h3 className="font-medium text-gray-900">Gestionar Cuentas</h3>
            <p className="text-sm text-gray-600 mt-1">Ver y editar cuentas</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
