import { 
  extraerMonto, 
  extraerFecha, 
  extraerMedioPago, 
  detectarTipo, 
  detectarCategoria,
  extraerDescripcion,
  parsearMensaje 
} from './parser.js';

describe('Parser de Mensajes de Telegram', () => {
  
  describe('extraerMonto', () => {
    test('debería extraer monto en formato chileno con puntos', () => {
      expect(extraerMonto('pagué 12.500 en el super')).toBe(12500);
      expect(extraerMonto('gasté $25.000')).toBe(25000);
    });
    
    test('debería extraer monto sin formato', () => {
      expect(extraerMonto('gasté 12500')).toBe(12500);
      expect(extraerMonto('pagué 5000 en uber')).toBe(5000);
    });
    
    test('debería extraer "lucas"', () => {
      expect(extraerMonto('gasté 5 lucas')).toBe(5000);
      expect(extraerMonto('pagué 12 lucas en el super')).toBe(12000);
      expect(extraerMonto('gasté 2.5 lucas')).toBe(2500);
    });
    
    test('debería extraer formato "k"', () => {
      expect(extraerMonto('gasté 5k')).toBe(5000);
      expect(extraerMonto('pagué 12k en comida')).toBe(12000);
    });
    
    test('debería retornar null si no encuentra monto', () => {
      expect(extraerMonto('fui al super')).toBeNull();
    });
  });

  describe('extraerFecha', () => {
    const hoy = new Date();
    const formatoHoy = formatearFechaTest(hoy);
    
    test('debería detectar "hoy"', () => {
      expect(extraerFecha('hoy pagué 5000')).toBe(formatoHoy);
    });
    
    test('debería detectar "ayer"', () => {
      const ayer = new Date(hoy);
      ayer.setDate(ayer.getDate() - 1);
      expect(extraerFecha('ayer gasté 12.500')).toBe(formatearFechaTest(ayer));
    });
    
    test('debería detectar "anteayer"', () => {
      const anteayer = new Date(hoy);
      anteayer.setDate(anteayer.getDate() - 2);
      expect(extraerFecha('anteayer fui al super')).toBe(formatearFechaTest(anteayer));
    });
    
    test('debería detectar días de la semana', () => {
      const resultado = extraerFecha('el lunes pagué');
      expect(resultado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    
    test('debería detectar formato dd/mm', () => {
      const resultado = extraerFecha('el 15/11 pagué 5000');
      expect(resultado).toMatch(/^\d{4}-11-15$/);
    });
    
    test('debería usar hoy por defecto', () => {
      expect(extraerFecha('gasté plata')).toBe(formatoHoy);
    });
  });

  describe('extraerMedioPago', () => {
    test('debería detectar débito', () => {
      expect(extraerMedioPago('pagué con débito')).toBe('débito');
      expect(extraerMedioPago('con debito')).toBe('débito');
      expect(extraerMedioPago('tarjeta de debito')).toBe('débito');
    });
    
    test('debería detectar crédito', () => {
      expect(extraerMedioPago('pagué con crédito')).toBe('crédito');
      expect(extraerMedioPago('con credito')).toBe('crédito');
    });
    
    test('debería detectar CMR', () => {
      expect(extraerMedioPago('con la CMR')).toBe('CMR');
      expect(extraerMedioPago('tarjeta falabella')).toBe('CMR');
    });
    
    test('debería detectar efectivo', () => {
      expect(extraerMedioPago('en efectivo')).toBe('efectivo');
      expect(extraerMedioPago('con cash')).toBe('efectivo');
    });
    
    test('debería detectar transferencia', () => {
      expect(extraerMedioPago('por transferencia')).toBe('transferencia');
      expect(extraerMedioPago('hice una transf')).toBe('transferencia');
    });
    
    test('debería retornar null si no detecta medio', () => {
      expect(extraerMedioPago('pagué algo')).toBeNull();
    });
  });

  describe('detectarTipo', () => {
    test('debería detectar ingresos', () => {
      expect(detectarTipo('me pagaron el sueldo')).toBe('abono');
      expect(detectarTipo('cobré 300.000')).toBe('abono');
      expect(detectarTipo('recibí un depósito')).toBe('abono');
      expect(detectarTipo('me depositaron el salario')).toBe('abono');
    });
    
    test('debería detectar gastos por defecto', () => {
      expect(detectarTipo('pagué 5 lucas')).toBe('cargo');
      expect(detectarTipo('gasté en el super')).toBe('cargo');
      expect(detectarTipo('compré comida')).toBe('cargo');
    });
  });

  describe('detectarCategoria', () => {
    test('debería detectar supermercado', () => {
      expect(detectarCategoria('fui al super')).toBe('Supermercado');
      expect(detectarCategoria('compré en jumbo')).toBe('Supermercado');
      expect(detectarCategoria('fui al lider')).toBe('Supermercado');
    });
    
    test('debería detectar transporte', () => {
      expect(detectarCategoria('tomé un uber')).toBe('Transporte');
      expect(detectarCategoria('pagué el metro')).toBe('Transporte');
      expect(detectarCategoria('eché bencina')).toBe('Transporte');
    });
    
    test('debería detectar comida', () => {
      expect(detectarCategoria('pedí comida')).toBe('Comida');
      expect(detectarCategoria('fui al restaurant')).toBe('Comida');
      expect(detectarCategoria('pedidos ya')).toBe('Comida');
    });
    
    test('debería detectar sueldo', () => {
      expect(detectarCategoria('me pagaron el sueldo')).toBe('Sueldo');
    });
    
    test('debería retornar null si no detecta categoría', () => {
      expect(detectarCategoria('pagué algo')).toBeNull();
    });
  });

  describe('extraerDescripcion', () => {
    test('debería extraer descripción sin monto', () => {
      expect(extraerDescripcion('ayer pagué 12.500 en el super')).toContain('en el super');
      expect(extraerDescripcion('gasté 5 lucas en uber')).toContain('en uber');
    });
    
    test('debería limpiar fechas relativas', () => {
      const desc = extraerDescripcion('hoy pagué 5000 en comida');
      expect(desc).not.toContain('hoy');
      expect(desc).toContain('en comida');
    });
  });

  describe('parsearMensaje - casos completos', () => {
    test('debería parsear "ayer pagué 12.500 en el super con débito"', () => {
      const resultado = parsearMensaje('ayer pagué 12.500 en el super con débito');
      
      expect(resultado.monto).toBe(12500);
      expect(resultado.tipo).toBe('cargo');
      expect(resultado.medioPago).toBe('débito');
      expect(resultado.categoriaDetectada).toBe('Supermercado');
      expect(resultado.descripcion).toContain('el super');
    });
    
    test('debería parsear "gasté 5 lucas en uber con la CMR"', () => {
      const resultado = parsearMensaje('gasté 5 lucas en uber con la CMR');
      
      expect(resultado.monto).toBe(5000);
      expect(resultado.tipo).toBe('cargo');
      expect(resultado.medioPago).toBe('CMR');
      expect(resultado.categoriaDetectada).toBe('Transporte');
    });
    
    test('debería parsear "me pagaron 300.000 de sueldo"', () => {
      const resultado = parsearMensaje('me pagaron 300.000 de sueldo');
      
      expect(resultado.monto).toBe(300000);
      expect(resultado.tipo).toBe('abono');
      expect(resultado.categoriaDetectada).toBe('Sueldo');
    });
    
    test('debería parsear "hoy gasté $2.500 en el metro"', () => {
      const resultado = parsearMensaje('hoy gasté $2.500 en el metro');
      
      expect(resultado.monto).toBe(2500);
      expect(resultado.tipo).toBe('cargo');
      expect(resultado.categoriaDetectada).toBe('Transporte');
    });
    
    test('debería parsear "el 15/11 compré en jumbo con crédito $45.000"', () => {
      const resultado = parsearMensaje('el 15/11 compré en jumbo con crédito $45.000');
      
      expect(resultado.monto).toBe(45000);
      expect(resultado.tipo).toBe('cargo');
      expect(resultado.medioPago).toBe('crédito');
      expect(resultado.categoriaDetectada).toBe('Supermercado');
      expect(resultado.fecha).toMatch(/^\d{4}-11-15$/);
    });
  });
});

// Helper para formatear fecha en tests
function formatearFechaTest(fecha) {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
}
