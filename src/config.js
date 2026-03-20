/**
 * Configuración centralizada de MojaveCode PHP.
 * Todos los magic numbers, timeouts, límites y defaults van acá.
 */

module.exports = {
  // Editor zoom
  zoom: {
    defaultFontSize: 14,
    minFontSize: 8,
    maxFontSize: 40,
    step: 1,
  },

  // Ventana principal
  window: {
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    bg: '#0d1a2a',
  },

  // Ejecución de procesos (child_process)
  exec: {
    timeout: 120000,       // 2 minutos — para composer install, migrations, etc.
    maxBuffer: 5 * 1024 * 1024, // 5MB
  },

  // Base de datos (CLI mysql/psql)
  db: {
    timeout: 15000,        // 15 segundos
    defaultPorts: { mysql: '3306', pgsql: '5432' },
    queryLimit: { default: 50, max: 200 },
  },

  // Búsqueda y file walking
  search: {
    maxFiles: 5000,
    maxDepth: 15,
    maxFileSize: 1024 * 1024,     // 1MB — para búsqueda en archivos
    maxSymbolFileSize: 512 * 1024, // 512KB — para extracción de símbolos
    maxResults: 500,
  },

  // Carpetas y archivos ignorados en búsquedas y file tree
  ignore: {
    dirs: new Set([
      'node_modules', '.git', 'vendor', 'dist', 'build',
      '.next', '__pycache__', '.idea', '.vscode', 'storage',
    ]),
    binaryExts: new Set([
      'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'woff', 'woff2',
      'ttf', 'eot', 'mp3', 'mp4', 'zip', 'gz', 'tar', 'pdf',
      'exe', 'dll', 'so', 'dylib', 'lock',
    ]),
  },

  // Xdebug (DBGp debugger)
  xdebug: {
    defaultPort: 9003,         // Xdebug 3 default (Xdebug 2 usaba 9000)
    connectionTimeout: 30000,  // 30s esperando respuesta
  },

  // Mapeo de extensiones a lenguajes para symbol extraction
  langExtMap: {
    php: 'php', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', java: 'java', go: 'go', rb: 'ruby', rs: 'rust',
  },
};
