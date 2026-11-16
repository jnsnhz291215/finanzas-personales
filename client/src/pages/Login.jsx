import { useState } from 'react';
import api from '../utils/api';

export default function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setCargando(true);

    try {
      const response = await api.post('/auth/login', { email, password });
      onLogin(response.data.usuario);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al iniciar sesión');
    } finally {
      setCargando(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-600 rounded-full mb-4">
              <i className="fas fa-wallet text-2xl text-white"></i>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Finanzas Personales</h1>
            <p className="text-gray-600 mt-2">Ingresa para ver tus finanzas</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <i className="fas fa-exclamation-circle mr-2"></i>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                placeholder="juan@finanzas.cl"
                required
                autoFocus
              />
            </div>

            <div>
              <label className="label">Contraseña</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              disabled={cargando}
              className="w-full btn btn-primary py-3 text-lg"
            >
              {cargando ? (
                <>
                  <i className="fas fa-spinner fa-spin mr-2"></i>
                  Iniciando sesión...
                </>
              ) : (
                <>
                  <i className="fas fa-sign-in-alt mr-2"></i>
                  Iniciar Sesión
                </>
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-sm text-gray-500">
            <p>Usuario por defecto: juan@finanzas.cl</p>
            <p className="text-xs mt-1">Cambia tu contraseña después del primer inicio</p>
          </div>
        </div>

        <div className="mt-4 text-center text-xs text-gray-500">
          <p>Aplicación personal de finanzas</p>
        </div>
      </div>
    </div>
  );
}
