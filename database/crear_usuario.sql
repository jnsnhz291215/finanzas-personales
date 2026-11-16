-- Crear usuario de MariaDB para Finanzas Personales de Juan
-- Este usuario SOLO tiene acceso a su propia base de datos
-- Ejecutar como root de MariaDB

-- Crear usuario (cambiar la contraseña por una segura)
CREATE USER IF NOT EXISTS 'finanzas_juan'@'localhost' IDENTIFIED BY 'tu_contraseña_segura_aqui';

-- Otorgar permisos ÚNICAMENTE sobre la base de datos de finanzas personales
GRANT ALL PRIVILEGES ON finanzas_personales_juan.* TO 'finanzas_juan'@'localhost';

-- Aplicar cambios
FLUSH PRIVILEGES;

-- Verificar permisos (opcional)
SHOW GRANTS FOR 'finanzas_juan'@'localhost';
