import { elegirMotor, variablesFaltantesMariaDB } from './motorDB.js';

describe('elegirMotor', () => {
  test('sqlite es el valor por defecto', () => {
    expect(elegirMotor({})).toBe('sqlite');
    expect(elegirMotor({ DB_ENGINE: '' })).toBe('sqlite');
    expect(elegirMotor({ DB_ENGINE: 'SQLite' })).toBe('sqlite');
  });

  test('mariadb (o mysql) se elige solo por la variable, aunque existan DB_HOST y compañía', () => {
    expect(elegirMotor({ DB_ENGINE: 'mariadb' })).toBe('mariadb');
    expect(elegirMotor({ DB_ENGINE: ' MySQL ' })).toBe('mariadb');
    expect(elegirMotor({ DB_HOST: 'localhost', DB_USER: 'x' })).toBe('sqlite');
  });

  test('un valor desconocido es un error claro', () => {
    expect(() => elegirMotor({ DB_ENGINE: 'postgres' })).toThrow(/DB_ENGINE/);
  });
});

describe('variablesFaltantesMariaDB', () => {
  test('lista las que faltan; la contraseña puede ser vacía pero debe existir', () => {
    expect(variablesFaltantesMariaDB({})).toEqual(['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']);
    expect(variablesFaltantesMariaDB({ DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: '', DB_NAME: 'n' })).toEqual([]);
    expect(variablesFaltantesMariaDB({ DB_HOST: ' ', DB_USER: 'u', DB_PASSWORD: 'p', DB_NAME: 'n' })).toEqual(['DB_HOST']);
  });
});
