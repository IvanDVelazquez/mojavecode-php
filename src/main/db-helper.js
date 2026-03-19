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
 *
 * Para SQLite devuelve { connection: 'sqlite', filePath } en lugar de
 * host/port/user/password — el archivo es toda la "conexión".
 */
function getConnectionConfig(env) {
  const conn = env.DB_CONNECTION || 'mysql';
  if (conn === 'sqlite') {
    return { connection: 'sqlite', filePath: env.DB_DATABASE || '' };
  }
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
 * Detecta todas las conexiones de BD en un .env parseado.
 * Busca patrones: DB_DATABASE, DB_{PREFIX}_DATABASE, DB_DATABASE_{SUFFIX}
 * Para cada una, intenta encontrar credenciales con el mismo prefijo/sufijo,
 * y si no existen, usa las credenciales por defecto (DB_HOST, etc.).
 * Retorna un array de { key, label, config }.
 */
function getAllConnectionConfigs(env) {
  const connections = [];
  const defaultConn = env.DB_CONNECTION || 'mysql';
  const defaults = {
    connection: defaultConn,
    host: env.DB_HOST || '127.0.0.1',
    port: env.DB_PORT || config.db.defaultPorts[defaultConn] || '3306',
    username: env.DB_USERNAME || '',
    password: env.DB_PASSWORD || '',
  };

  for (const key of Object.keys(env)) {
    let label = null;
    let prefix = null;

    if (key === 'DB_DATABASE') {
      // Default connection
      label = 'default';
      prefix = 'DB';
    } else if (/^DB_([A-Z0-9_]+)_DATABASE$/.test(key)) {
      // DB_{PREFIX}_DATABASE — e.g. DB_ADMIN_DATABASE
      const match = key.match(/^DB_([A-Z0-9_]+)_DATABASE$/);
      label = match[1].toLowerCase();
      prefix = `DB_${match[1]}`;
    } else if (/^DB_DATABASE_([A-Z0-9_]+)$/.test(key)) {
      // DB_DATABASE_{SUFFIX} — e.g. DB_DATABASE_BLOG
      const match = key.match(/^DB_DATABASE_([A-Z0-9_]+)$/);
      label = match[1].toLowerCase();
      prefix = `DB_${match[1]}`;
    } else {
      continue;
    }

    const database = env[key];
    if (!database) continue;

    // Buscar credenciales específicas para esta conexión, fallback a defaults
    const conn = env[`${prefix}_CONNECTION`] || defaults.connection;

    // ── SQLite: solo necesita el path del archivo ─────────────────
    if (conn === 'sqlite') {
      connections.push({
        key: label,
        label: label === 'default' ? database : `${label} (${database})`,
        config: { connection: 'sqlite', filePath: database },
      });
      continue;
    }

    connections.push({
      key: label,
      label: label === 'default' ? database : `${label} (${database})`,
      config: {
        connection: conn,
        host: env[`${prefix}_HOST`] || defaults.host,
        port: env[`${prefix}_PORT`] || config.db.defaultPorts[conn] || defaults.port,
        database,
        username: env[`${prefix}_USERNAME`] || defaults.username,
        password: env[`${prefix}_PASSWORD`] || defaults.password,
      },
    });
  }

  // Si no encontró nada, intentar con la config por defecto
  if (connections.length === 0 && env.DB_DATABASE) {
    connections.push({
      key: 'default',
      label: env.DB_DATABASE,
      config: { ...defaults, database: env.DB_DATABASE },
    });
  }

  return connections;
}

/**
 * Ejecuta un query SQL contra la base de datos configurada.
 *
 * Soporta tres motores: MySQL (default), PostgreSQL (pgsql) y SQLite.
 * SQLite no necesita CLI externa en macOS — sqlite3 viene preinstalado.
 *
 * DIFERENCIAS SQLITE:
 * ───────────────────
 * • No tiene host/port/user — solo un archivo .db/.sqlite
 * • Modo CSV:    sqlite3 -csv archivo.db "SQL"
 * • Modo normal: sqlite3 -separator "\t" archivo.db "SQL"  (tab-delimitado,
 *   igual que MySQL -N, para que el parser del renderer no cambie)
 * • No acepta backticks — usar comillas dobles para identificadores
 *
 * @param {object} dbConfig - Config de conexión ({ connection, filePath } para SQLite)
 * @param {string} sql      - Query a ejecutar
 * @param {object} options  - { csv: bool }
 * @returns {Promise<{ output?: string, error?: string }>}
 */
function execDb(dbConfig, sql, options = {}) {
  const { csv = false } = options;
  const timeout = config.db.timeout;

  // ── SQLite ────────────────────────────────────────────────────
  if (dbConfig.connection === 'sqlite') {
    const args = csv
      ? ['-csv', dbConfig.filePath, sql]
      : ['-separator', '\t', dbConfig.filePath, sql];

    return new Promise((resolve) => {
      execFile('sqlite3', args, { timeout }, (err, stdout, stderr) => {
        if (err) return resolve({ error: stderr || err.message });
        resolve({ output: stdout.trim() });
      });
    });
  }

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
  getAllConnectionConfigs,
  execDb,
  sanitizeIdentifier,
  sanitizeValue,
  parseCsvLine,
};
