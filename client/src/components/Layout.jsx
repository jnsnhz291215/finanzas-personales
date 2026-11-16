import { Link, useLocation } from 'react-router-dom';

export default function Layout({ usuario, onLogout, children }) {
  const location = useLocation();

  const menuItems = [
    { path: '/', icon: 'fa-home', label: 'Panel' },
    { path: '/movimientos', icon: 'fa-list', label: 'Movimientos' },
    { path: '/cuentas', icon: 'fa-credit-card', label: 'Cuentas' },
    { path: '/importar', icon: 'fa-file-import', label: 'Importar' },
    { path: '/prestamos', icon: 'fa-handshake', label: 'Préstamos' },
    { path: '/categorias', icon: 'fa-tags', label: 'Categorías' }
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center">
              <i className="fas fa-wallet text-2xl text-blue-600 mr-3"></i>
              <h1 className="text-xl font-bold text-gray-900">Finanzas Personales</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-600">
                <i className="fas fa-user mr-2"></i>
                {usuario.nombre}
              </span>
              <button
                onClick={onLogout}
                className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
              >
                <i className="fas fa-sign-out-alt mr-1"></i>
                Salir
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex space-x-1 overflow-x-auto">
            {menuItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`
                    flex items-center px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap
                    ${isActive
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                    }
                  `}
                >
                  <i className={`fas ${item.icon} mr-2`}></i>
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 mt-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <p className="text-center text-sm text-gray-500">
            Finanzas Personales - Aplicación privada
          </p>
        </div>
      </footer>
    </div>
  );
}
