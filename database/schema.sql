-- Base de Datos para Finanzas Personales de Juan
-- MariaDB / MySQL
-- IMPORTANTE: Esta es una base de datos totalmente separada e independiente
-- No compartir con ninguna otra aplicación

CREATE DATABASE IF NOT EXISTS finanzas_personales_juan CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE finanzas_personales_juan;

-- Tabla de Usuario (un solo usuario)
CREATE TABLE IF NOT EXISTS usuario (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL,
  email VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Cuentas y Tarjetas
CREATE TABLE IF NOT EXISTS cuentas (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(150) NOT NULL,
  tipo ENUM('cuenta_corriente', 'cuenta_vista', 'cuenta_ahorro', 'tarjeta_credito', 'tarjeta_debito', 'efectivo') NOT NULL,
  banco VARCHAR(100),
  numero_cuenta VARCHAR(50),
  ultimos4 VARCHAR(4) NULL,
  ultimos4_cuenta VARCHAR(4) NULL,
  titular VARCHAR(150) NULL,
  cupo_total DECIMAL(15,2) DEFAULT NULL,
  dia_facturacion INT DEFAULT NULL,
  dia_vencimiento INT DEFAULT NULL,
  activa BOOLEAN DEFAULT TRUE,
  predeterminada BOOLEAN NOT NULL DEFAULT FALSE,
  notas TEXT,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Categorías
CREATE TABLE IF NOT EXISTS categorias (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  color VARCHAR(7) DEFAULT '#6B7280',
  icono VARCHAR(50) DEFAULT 'fa-folder',
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insertar categorías por defecto
INSERT INTO categorias (nombre, color, icono) VALUES
('Supermercado', '#10B981', 'fa-shopping-cart'),
('Transporte', '#3B82F6', 'fa-bus'),
('Comida', '#F59E0B', 'fa-utensils'),
('Cuentas y Servicios', '#EF4444', 'fa-file-invoice-dollar'),
('Suscripciones', '#8B5CF6', 'fa-sync'),
('Salud', '#EC4899', 'fa-heartbeat'),
('Entretenimiento', '#14B8A6', 'fa-film'),
('Educación', '#6366F1', 'fa-graduation-cap'),
('Vivienda', '#F97316', 'fa-home'),
('Ingresos', '#22C55E', 'fa-arrow-down'),
('Otros', '#6B7280', 'fa-ellipsis-h')
ON DUPLICATE KEY UPDATE nombre=nombre;

-- Tabla de Reglas de Autocategorización
CREATE TABLE IF NOT EXISTS reglas_categoria (
  id INT PRIMARY KEY AUTO_INCREMENT,
  texto_buscar VARCHAR(255) NOT NULL,
  categoria_id INT NOT NULL,
  activa BOOLEAN DEFAULT TRUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Movimientos
CREATE TABLE IF NOT EXISTS movimientos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  cuenta_id INT NOT NULL,
  fecha DATE NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  monto DECIMAL(15,2) NOT NULL,
  tipo ENUM('cargo', 'abono') NOT NULL,
  tipo_movimiento ENUM('compra', 'pago_tarjeta', 'transferencia_propia', 'transferencia_terceros', 'ingreso', 'otro') NOT NULL DEFAULT 'compra',
  cuenta_destino_id INT NULL,
  compra_cuota_id INT NULL,
  numero_cuota SMALLINT NULL,
  gasto_fijo_id INT NULL,
  categoria_id INT,
  persona_prestamo VARCHAR(100) DEFAULT NULL,
  es_prestamo BOOLEAN DEFAULT FALSE,
  notas TEXT,
  archivo_respaldo VARCHAR(255) DEFAULT NULL,
  importado_de VARCHAR(255) DEFAULT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE CASCADE,
  FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL,
  FOREIGN KEY (cuenta_destino_id) REFERENCES cuentas(id) ON DELETE SET NULL,
  INDEX idx_tipo_movimiento (tipo_movimiento),
  INDEX idx_cuenta_destino (cuenta_destino_id),
  INDEX idx_fecha (fecha),
  INDEX idx_cuenta (cuenta_id),
  INDEX idx_categoria (categoria_id),
  INDEX idx_prestamo (es_prestamo, persona_prestamo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Compras en cuotas a una persona o tarjeta ajena (por ejemplo, un MacBook en 12 cuotas)
CREATE TABLE IF NOT EXISTS compras_cuotas (
  id INT PRIMARY KEY AUTO_INCREMENT,
  alias VARCHAR(100) NOT NULL,
  alias_cartola VARCHAR(100) NULL,
  acreedor VARCHAR(100) NOT NULL,
  monto_total DECIMAL(15,2) NULL,
  monto_cuota DECIMAL(15,2) NOT NULL,
  total_cuotas SMALLINT NOT NULL,
  cuotas_pagadas SMALLINT NOT NULL DEFAULT 0,
  fecha_inicio DATE NULL,
  dia_pago TINYINT NULL,
  terminada BOOLEAN NOT NULL DEFAULT FALSE,
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_activa_terminada (activa, terminada)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cada pago de cuota es un movimiento ligado a su compra (movimientos se crea antes)
ALTER TABLE movimientos
  ADD INDEX idx_movimientos_compra_cuota (compra_cuota_id),
  ADD CONSTRAINT fk_movimientos_compra_cuota
    FOREIGN KEY (compra_cuota_id) REFERENCES compras_cuotas(id) ON DELETE SET NULL;

-- Plan de ahorro mensual (una sola fila) y gastos fijos
CREATE TABLE IF NOT EXISTS plan_ahorro (
  id TINYINT PRIMARY KEY DEFAULT 1,
  ingreso_base DECIMAL(15,2) NULL,
  pct_fijos DECIMAL(5,2) NOT NULL DEFAULT 50,
  pct_libres DECIMAL(5,2) NOT NULL DEFAULT 30,
  pct_ahorro DECIMAL(5,2) NOT NULL DEFAULT 20,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO plan_ahorro (id) VALUES (1);

CREATE TABLE IF NOT EXISTS gastos_fijos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL,
  monto DECIMAL(15,2) NOT NULL,
  dia_pago TINYINT NULL,
  categoria_id INT NULL,
  cuenta_id INT NULL,
  palabras_clave VARCHAR(255) NULL,
  destinatario VARCHAR(100) NULL,
  destinatario_id INT NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL,
  FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL,
  INDEX idx_activo (activo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mis datos de transferencia (los que entrego para que me depositen), uno por cuenta o institución
CREATE TABLE IF NOT EXISTS datos_transferencia (
  id INT PRIMARY KEY AUTO_INCREMENT,
  cuenta_id INT NULL,
  alias VARCHAR(100) NOT NULL,
  nombre_titular VARCHAR(150) NOT NULL,
  rut VARCHAR(12) NOT NULL,
  banco VARCHAR(100) NOT NULL,
  tipo_cuenta ENUM('corriente', 'vista', 'rut', 'ahorro') NOT NULL,
  numero_cuenta VARCHAR(30) NOT NULL,
  email VARCHAR(150) NULL,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL,
  INDEX idx_banco_numero (banco, numero_cuenta)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Pagos de Préstamos (para liquidar deudas entre personas)
CREATE TABLE IF NOT EXISTS pagos_prestamos (
  id INT PRIMARY KEY AUTO_INCREMENT,
  persona VARCHAR(100) NOT NULL,
  monto DECIMAL(15,2) NOT NULL,
  fecha DATE NOT NULL,
  notas TEXT,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_persona (persona)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de Archivos Importados (para evitar duplicados)
CREATE TABLE IF NOT EXISTS archivos_importados (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nombre_archivo VARCHAR(255) NOT NULL,
  hash_archivo VARCHAR(64) NOT NULL,
  cuenta_id INT,
  cantidad_movimientos INT DEFAULT 0,
  fecha_importacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ruta_archivo VARCHAR(500),
  periodo_desde DATE NULL,
  periodo_hasta DATE NULL,
  cargos_leidos INT NULL,
  marcados_mios INT NULL,
  ignorados INT NULL,
  FOREIGN KEY (cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL,
  INDEX idx_hash (hash_archivo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cargos leídos de cartolas de tarjetas de terceros (para reconocer compras que se repiten cada mes)
CREATE TABLE IF NOT EXISTS cargos_cartola (
  id INT PRIMARY KEY AUTO_INCREMENT,
  cuenta_id INT NOT NULL,
  hash_archivo VARCHAR(64) NOT NULL,
  fecha DATE NOT NULL,
  descripcion VARCHAR(255) NOT NULL,
  monto DECIMAL(15,2) NOT NULL,
  cuota_actual INT NULL,
  cuota_total INT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cargos_cartola_cuenta (cuenta_id),
  INDEX idx_cargos_cartola_hash (hash_archivo)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Mensajes de Telegram que crearon cada registro (para eliminar/corregir respondiéndoles)
CREATE TABLE IF NOT EXISTS mensajes_registro (
  id INT PRIMARY KEY AUTO_INCREMENT,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  registro_id INT NOT NULL,
  creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mensajes_registro_msg (chat_id, message_id),
  INDEX idx_mensajes_registro_reg (tipo, registro_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Historial de eliminaciones y correcciones hechas desde el bot (permite deshacer por 24 h)
CREATE TABLE IF NOT EXISTS historial_cambios (
  id INT PRIMARY KEY AUTO_INCREMENT,
  fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  creado_ms BIGINT NOT NULL,
  accion VARCHAR(20) NOT NULL,
  tipo VARCHAR(30) NOT NULL,
  registro_id INT NULL,
  chat_id BIGINT NULL,
  antes LONGTEXT NULL,
  despues LONGTEXT NULL,
  deshecho BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX idx_historial_cambios_reg (tipo, registro_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Clasificación elegida para las transferencias a cada destinatario (gasto, préstamo o pago)
CREATE TABLE IF NOT EXISTS destinatarios_transferencia (
  id INT PRIMARY KEY AUTO_INCREMENT,
  clave VARCHAR(100) NOT NULL UNIQUE,
  nombre VARCHAR(100) NOT NULL,
  clasificacion VARCHAR(20) NOT NULL,
  actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
