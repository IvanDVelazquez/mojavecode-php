/**
 * Helper de base de datos — parsea .env y ejecuta queries via CLI.
 * Soporta MySQL y PostgreSQL. No usa drivers de npm, solo los
 * clientes CLI del SO (mysql, psql).
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

/**
 * Parsea un archivo .env y devuelve un objeto clave-valor.
 */
function parseEnvFile(folderPath) {
  const envPath = path.join(folderPath, '.env');
  if (!fs.existsSync(envPath)) return null;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex).trim();
      let val = trimmed.substring(eqIndex + 1).trim();
      // Quitar comillas
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return null;
  }
}

/**
 * Extrae la config de conexión de un .env parseado.
 */
function getConnectionConfig(env) {
  const conn = env.DB_CONNECTION || 'mysql';
  return {
    connection: conn,
    host: env.DB_HOST || '127.0.0.1',
    port: env.DB_PORT || config.db.defaultPorts[conn] || '3306',
    database: env.DB_DATABASE || '',
    username: env.DB_USERNAME || '',
    password: env.DB_PASSWORD || '',
  };
}

/**
 * Ejecuta un comando mysql/psql y devuelve una Promise con el resultado.
 */
function execDb(dbConfig, sql, options = {}) {
  const { csv = false } = options;
  const timeout = config.db.timeout;

  if (dbConfig.connection === 'pgsql') {
    const pgEnv = { ...process.env, PGPASSWORD: dbConfig.password };
    const args = [
      '-h', dbConfig.host, '-p', dbConfig.port,
      '-U', dbConfig.username, '-d', dbConfig.database,
    ];
    if (csv) {
      args.push('--csv', '-c', sql);
    } else {
      args.push('-t', '-A', '-c', sql);
    }
    return new Promise((resolve) => {
      execFile('psql', args, { env: pgEnv, timeout }, (err, stdout, stderr) => {
        if (err) return resolve({ error: stderr || err.message });
        resolve({ output: stdout.trim() });
      });
    });
  }

  // MySQL (default)
  const args = ['-h', dbConfig.host, '-P', dbConfig.port, '-u', dbConfig.username, dbConfig.database];
  if (dbConfig.password) args.splice(4, 0, `-p${dbConfig.password}`);
  if (csv) {
    args.push('-e', sql, '--batch');
  } else {
    args.push('-N', '-e', sql);
  }
  return new Promise((resolve) => {
    execFile('mysql', args, { timeout }, (err, stdout, stderr) => {
      if (err) return resolve({ error: stderr || err.message });
      resolve({ output: stdout.trim() });
    });
  });
}

/**
 * Sanitiza un nombre de tabla o columna (solo alfanuméricos y underscore).
 */
function sanitizeIdentifier(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Sanitiza un valor para SQL (escapa comillas simples).
 */
function sanitizeValue(val) {
  return String(val).replace(/'/g, "''");
}

/**
 * Parsea una línea CSV simple (para psql --csv output).
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

module.exports = {
  parseEnvFile,
  getConnectionConfig,
  execDb,
  sanitizeIdentifier,
  sanitizeValue,
  parseCsvLine,
};
