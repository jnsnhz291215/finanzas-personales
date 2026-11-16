import express from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db.js';

const router = express.Router();

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }
    
    const [usuarios] = await query(
      'SELECT * FROM usuario WHERE email = ?',
      [email]
    );
    
    if (usuarios.length === 0) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    const usuario = usuarios[0];
    const passwordValido = await bcrypt.compare(password, usuario.password_hash);
    
    if (!passwordValido) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }
    
    req.session.userId = usuario.id;
    req.session.nombre = usuario.nombre;
    
    res.json({
      success: true,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email
      }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Error al cerrar sesión' });
    }
    res.json({ success: true });
  });
});

// Verificar sesión
router.get('/me', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  
  try {
    const [usuarios] = await query(
      'SELECT id, nombre, email FROM usuario WHERE id = ?',
      [req.session.userId]
    );
    
    if (usuarios.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }
    
    res.json({ usuario: usuarios[0] });
  } catch (error) {
    console.error('Error al verificar sesión:', error);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Cambiar contraseña
router.post('/cambiar-password', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  try {
    const { passwordActual, passwordNueva } = req.body;
    
    if (!passwordActual || !passwordNueva) {
      return res.status(400).json({ error: 'Contraseñas requeridas' });
    }
    
    if (passwordNueva.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }
    
    const [usuarios] = await query(
      'SELECT * FROM usuario WHERE id = ?',
      [req.session.userId]
    );
    
    const passwordValido = await bcrypt.compare(passwordActual, usuarios[0].password_hash);
    
    if (!passwordValido) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }
    
    const nuevoHash = await bcrypt.hash(passwordNueva, 10);
    await query(
      'UPDATE usuario SET password_hash = ? WHERE id = ?',
      [nuevoHash, req.session.userId]
    );
    
    res.json({ success: true, message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    console.error('Error al cambiar contraseña:', error);
    res.status(500).json({ error: 'Error al cambiar contraseña' });
  }
});

export default router;
