/**
 * ══════════════════════════════════════════════════════════════
 * PATH UTILITIES — Cross-platform path helpers
 * ══════════════════════════════════════════════════════════════
 *
 * Funciones compartidas entre main.js, lsp-manager.js y
 * xdebug-manager.js para manejar rutas de forma correcta
 * en macOS, Windows y Linux.
 */

const path = require('path');
const os = require('os');

/**
 * Convierte una ruta del filesystem a una URI file:// válida.
 *
 * En Unix: /home/user/project → file:///home/user/project
 * En Windows: C:\Users\project → file:///C:/Users/project
 *
 * @param {string} filePath - Ruta absoluta del filesystem
 * @returns {string} URI file:// válida
 */
function pathToFileUri(filePath) {
  let normalized = filePath.split(path.sep).join('/');
  // Windows: agregar slash antes de la letra de drive (C: → /C:)
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(normalized)) {
    normalized = '/' + normalized;
  }
  return 'file://' + normalized;
}

/**
 * Convierte una URI file:// a una ruta del filesystem local.
 *
 * file:///home/user/project → /home/user/project (Unix)
 * file:///C:/Users/project  → C:\Users\project   (Windows)
 *
 * @param {string} fileUri - URI file://
 * @returns {string} Ruta del filesystem
 */
function fileUriToPath(fileUri) {
  let filePath = fileUri.replace(/^file:\/{2,3}/, '');
  // Decodificar caracteres URL-encoded (%20 → espacio, etc.)
  filePath = decodeURIComponent(filePath);
  // Windows: quitar el slash inicial antes de la letra de drive (/C: → C:)
  if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
    filePath = filePath.slice(1);
  }
  // Normalizar separadores al estilo de la plataforma
  return filePath.split('/').join(path.sep);
}

/**
 * Abrevia una ruta reemplazando el home directory con ~.
 * Funciona en macOS (/Users/x), Windows (C:\Users\x) y Linux (/home/x).
 *
 * @param {string} filePath - Ruta absoluta
 * @returns {string} Ruta abreviada con ~ o la original si no está bajo home
 */
function abbreviateHome(filePath) {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return '~' + filePath.slice(home.length);
  }
  return filePath;
}

module.exports = { pathToFileUri, fileUriToPath, abbreviateHome };
