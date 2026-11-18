import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import api from './utils/api';
import Login from './pages/Login';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Cuentas from './pages/Cuentas';
import Movimientos from './pages/Movimientos';
import Importar from './pages/Importar';
import Prestamos from './pages/Prestamos';
import Categorias from './pages/Categorias';
import PlanAhorro from './pages/PlanAhorro';

function App() {
  const [usuario, setUsuario] = useState(null);
  const [cargando, setCargando] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    verificarSesion();
  }, []);

  const verificarSesion = async () => {
    try {
      const response = await api.get('/auth/me');
      setUsuario(response.data.usuario);
    } catch (error) {
      setUsuario(null);
    } finally {
      setCargando(false);
    }
  };

  const handleLogin = (usuarioData) => {
    setUsuario(usuarioData);
    navigate('/');
  };

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout');
      setUsuario(null);
      navigate('/login');
    } catch (error) {
      console.error('Error al cerrar sesión:', error);
    }
  };

  if (cargando) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <i className="fas fa-spinner fa-spin text-4xl text-blue-600 mb-4"></i>
          <p className="text-gray-600">Cargando...</p>
        </div>
      </div>
    );
  }

  if (!usuario) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={handleLogin} />} />
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  return (
    <Layout usuario={usuario} onLogout={handleLogout}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/cuentas" element={<Cuentas />} />
        <Route path="/movimientos" element={<Movimientos />} />
        <Route path="/importar" element={<Importar />} />
        <Route path="/prestamos" element={<Prestamos />} />
        <Route path="/categorias" element={<Categorias />} />
        <Route path="/plan-ahorro" element={<PlanAhorro />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}

export default App;
