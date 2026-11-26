import fs from 'fs';
import { elegirMotor, variablesFaltantesMariaDB, sentenciasDeEsquema, describirErrorBD } from './motorDB.js';

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

describe('sentenciasDeEsquema', () => {
  test('quita comentarios, CREATE DATABASE, USE y ALTER TABLE', () => {
    const sql = '-- comentario\nCREATE DATABASE x;\nUSE x;\nCREATE TABLE IF NOT EXISTS a (id INT);\nALTER TABLE a ADD INDEX i (id);\nINSERT IGNORE INTO a (id) VALUES (1);';
    expect(sentenciasDeEsquema(sql)).toEqual(['CREATE TABLE IF NOT EXISTS a (id INT)', 'INSERT IGNORE INTO a (id) VALUES (1)']);
  });

  test('database/schema.sql solo deja sentencias idempotentes', () => {
    const texto = fs.readFileSync(new URL('../database/schema.sql', import.meta.url), 'utf8');
    const sentencias = sentenciasDeEsquema(texto);
    expect(sentencias.length).toBeGreaterThan(10);
    for (const s of sentencias) expect(s).toMatch(/^(CREATE TABLE IF NOT EXISTS|INSERT)/i);
  });
});

describe('describirErrorBD', () => {
  test('explica los errores conocidos en lenguaje simple', () => {
    expect(describirErrorBD({ code: 'ECONNREFUSED' })).toMatch(/encendido/);
    expect(describirErrorBD({ code: 'ER_ACCESS_DENIED_ERROR' })).toMatch(/usuario o la contraseña/);
    expect(describirErrorBD({ code: 'ER_BAD_DB_ERROR' })).toMatch(/no existe/);
  });

  test('nunca imprime la contraseña', () => {
    const t = describirErrorBD(new Error('fallo con claveSecreta123 dentro'), { DB_PASSWORD: 'claveSecreta123' });
    expect(t).not.toContain('claveSecreta123');
    expect(t).toContain('***');
  });
});
