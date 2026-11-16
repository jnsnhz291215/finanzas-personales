import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  withCredentials: true
});

// Interceptor para manejar errores
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      // Redirigir al login si no está autorizado
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
