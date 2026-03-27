/**
 * ══════════════════════════════════════════════════════════════
 * MAIN PROCESS (main.js)
 * ══════════════════════════════════════════════════════════════
 *
 * Este es el "backend" de la app Electron. Corre en Node.js y se
 * encarga de:
 *
 * 1. Crear la ventana del browser (BrowserWindow)
 * 2. Manejar el menú nativo del SO (dinámico según proyecto)
 * 3. Escuchar mensajes IPC del renderer (frontend)
 * 4. Acceder al filesystem (fs) y procesos del SO (child_process)
 * 5. Spawning de la pseudo-terminal (node-pty) para xterm.js
 * 6. Detección de proyecto (Composer, Artisan, Pint, PHPUnit, Modules)
 * 7. Búsqueda de archivos y símbolos en el proyecto
 * 8. Ejecución de Composer, Artisan, PHPUnit, PHP Formatter
 * 9. Conexión a base de datos via CLI (mysql/psql)
 * 10. Resolución de namespaces PSR-4
 *
 * ARQUITECTURA ELECTRON:
 * ┌─────────────┐     IPC      ┌──────────────┐
 * │ Main Process│◄────────────►│Renderer (UI)  │
 * │  (Node.js)  │  (mensajes)  │ (Chromium)    │
 * └─────────────┘              └──────────────┘
 *
 * El main NO puede tocar el DOM. El renderer NO puede acceder
 * a fs/child_process directamente (por seguridad). Se comunican
 * via IPC (Inter-Process Communication).
 * ══════════════════════════════════════════════════════════════
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execSync, spawn } = require('child_process');
const config = require('../config');
const db = require('./db-helper');
const { abbreviateHome } = require('./path-utils');

// ── Fix PATH para apps empaquetadas en macOS ──
// Cuando Electron corre como .app, el PATH es mínimo (/usr/bin:/bin:/usr/sbin:/sbin).
// Binarios como php, mysql, composer (instalados via Homebrew, MAMP, Herd, etc.)
// no se encuentran. Reconstruimos el PATH desde las fuentes del sistema + paths comunes.
// ── PATH fix para apps empaquetadas (macOS, Windows, Linux) ──
// Cuando Electron empaqueta la app, el PATH se reduce al mínimo del SO
// (e.g. /usr/bin en Unix, C:\Windows\System32 en Windows).
// Los binarios de desarrollo (php, mysql, psql, composer, docker) no se
// encuentran. Acá agregamos los paths comunes de cada plataforma.
if (app.isPackaged) {
  const home = os.homedir();
  const sep = path.delimiter; // ':' en Unix, ';' en Windows
  const extraPaths = [];

  if (process.platform === 'darwin') {
    // ── macOS ─────────────────────────────────────────────────
    extraPaths.push(
      '/opt/homebrew/bin', '/opt/homebrew/sbin',              // Homebrew ARM (M1+)
      '/opt/homebrew/opt/php@8.1/bin',                        // PHP versionado
      '/opt/homebrew/opt/php@8.2/bin',
      '/opt/homebrew/opt/php@8.3/bin',
      '/opt/homebrew/opt/php@8.4/bin',
      '/opt/homebrew/opt/mysql/bin',                           // MySQL via Homebrew
      '/opt/homebrew/opt/mysql-client/bin',
      '/usr/local/bin', '/usr/local/sbin',                     // Homebrew Intel
      '/usr/local/opt/php@8.1/bin',
      '/usr/local/opt/php@8.2/bin',
      '/usr/local/opt/php@8.3/bin',
      '/usr/local/opt/mysql/bin',
      '/usr/local/mysql/bin',                                  // MySQL installer oficial
      `${home}/.composer/vendor/bin`,                          // Composer global
      `${home}/Library/Application Support/Herd/bin`,          // Laravel Herd
      '/Applications/MAMP/bin/php/php8.2.0/bin',               // MAMP
      '/Applications/MAMP/Library/bin',
    );
    // Leer /etc/paths y /etc/paths.d/* (fuente oficial de PATH en macOS)
    try {
      const systemPaths = fs.readFileSync('/etc/paths', 'utf8').trim().split('\n');
      const pathsDir = '/etc/paths.d';
      if (fs.existsSync(pathsDir)) {
        for (const file of fs.readdirSync(pathsDir)) {
          const content = fs.readFileSync(path.join(pathsDir, file), 'utf8').trim();
          if (content) systemPaths.push(...content.split('\n'));
        }
      }
      extraPaths.push(...systemPaths);
    } catch { /* ignorar si no se puede leer */ }

  } else if (process.platform === 'win32') {
    // ── Windows ───────────────────────────────────────────────
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    extraPaths.push(
      // XAMPP (la más común en Windows)
      'C:\\xampp\\php',
      'C:\\xampp\\mysql\\bin',
      // WampServer
      'C:\\wamp64\\bin\\php\\php8.2', 'C:\\wamp64\\bin\\php\\php8.3', 'C:\\wamp64\\bin\\php\\php8.4',
      'C:\\wamp64\\bin\\mysql\\mysql8.0\\bin', 'C:\\wamp64\\bin\\mysql\\mysql8.4\\bin',
      'C:\\wamp\\bin\\php\\php8.2', 'C:\\wamp\\bin\\php\\php8.3',
      'C:\\wamp\\bin\\mysql\\mysql8.0\\bin',
      // Laragon
      'C:\\laragon\\bin\\php\\php-8.2', 'C:\\laragon\\bin\\php\\php-8.3', 'C:\\laragon\\bin\\php\\php-8.4',
      'C:\\laragon\\bin\\mysql\\mysql-8.0\\bin', 'C:\\laragon\\bin\\mysql\\mysql-8.4\\bin',
      // Instaladores oficiales / Chocolatey / Scoop
      `${programFiles}\\PHP`, `${programFiles}\\PHP\\php8.2`, `${programFiles}\\PHP\\php8.3`,
      `${programFiles}\\MySQL\\MySQL Server 8.0\\bin`, `${programFiles}\\MySQL\\MySQL Server 8.4\\bin`,
      `${programFiles}\\PostgreSQL\\16\\bin`, `${programFiles}\\PostgreSQL\\17\\bin`,
      `${programFilesX86}\\PHP`,
      // Composer global
      `${appData}\\Composer\\vendor\\bin`,
      // Scoop
      `${home}\\scoop\\shims`,
      // Laravel Herd for Windows
      `${localAppData}\\Programs\\Herd\\resources\\bin`,
      // Docker Desktop CLI
      `${programFiles}\\Docker\\Docker\\resources\\bin`,
    );

  } else {
    // ── Linux ─────────────────────────────────────────────────
    extraPaths.push(
      '/usr/local/bin', '/usr/bin', '/usr/sbin',
      '/usr/local/sbin',
      '/snap/bin',                                             // Snap packages (Ubuntu)
      `${home}/.config/composer/vendor/bin`,                   // Composer global (Linux)
      `${home}/.composer/vendor/bin`,                          // Composer global (alt)
      '/usr/local/mysql/bin',                                  // MySQL desde tarball
      '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', // PostgreSQL Debian/Ubuntu
    );
  }

  // Filtrar solo paths que existen y agregar al PATH actual
  const existing = extraPaths.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
  process.env.PATH = [...new Set([...existing, ...process.env.PATH.split(sep)])].join(sep);
}

// ── Carpetas recientes ──
// Se guardan en un JSON en userData para que el menú nativo
// pueda leerlas sincrónicamente al construirse.
const RECENT_FILE = path.join(app.getPath('userData'), 'recent-folders.json');

// ── Tema persistente ──
// Se guarda en un JSON en userData para compartir entre ventanas/procesos.
// localStorage de Chromium no se comparte entre procesos Electron separados,
// así que usamos un archivo como fuente de verdad.
const THEME_FILE = path.join(app.getPath('userData'), 'theme-config.json');

function getThemeConfig() {
  try {
    return JSON.parse(fs.readFileSync(THEME_FILE, 'utf-8'));
  } catch {
    return { activeTheme: 'dark', customThemes: [] };
  }
}

function saveThemeConfig(config) {
  try {
    fs.writeFileSync(THEME_FILE, JSON.stringify(config), 'utf-8');
  } catch { /* ignorar */ }
}
const MAX_RECENT = 5;

function getRecentFolders() {
  try {
    return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRecentFolder(folderPath) {
  let recent = getRecentFolders().filter((p) => p !== folderPath);
  recent.unshift(folderPath);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  try {
    fs.writeFileSync(RECENT_FILE, JSON.stringify(recent), 'utf-8');
  } catch { /* ignorar */ }
  return recent;
}

// node-pty: pseudo-terminal para la terminal integrada
// Se importa con try/catch porque es un native module que
// puede fallar si no se compiló correctamente
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.warn('node-pty not available:', e.message);
}

const { LspManager } = require('./lsp-manager');
const XdebugManager = require('./xdebug-manager');

let mainWindow;
/** @type {Map<number, import('node-pty').IPty>} */
const ptyProcesses = new Map();
let ptyNextId = 1;
let lspManager = null;
let tsLspManager = null;
let xdebugManager = null;

// ── Temas custom del usuario (sincronizados desde el renderer) ──
let customThemeEntries = []; // Array de { id, name }

// ── Estado de detección de proyecto ──
let projectCapabilities = {
  hasComposer: false,
  hasArtisan: false,
  hasModules: false, // nwidart/laravel-modules
  hasPint: false,
  hasCsFixer: false,
  hasPhpUnit: false,
  hasDocker: false, // Dockerfile o docker-compose presente
  dockerEnv: false, // .env contiene host.docker.internal
  dockerContainer: null, // nombre del contenedor Docker
  dockerWorkdir: null, // workdir dentro del contenedor
  hasSail: false,    // vendor/bin/sail presente
  sailEnabled: false, // usuario habilitó modo Sail (auto-activado al detectar Sail)
  hasClaude: false,  // claude CLI disponible en PATH
  formatOnSave: false, // desactivado por defecto
  autoSave: false, // auto-save desactivado por defecto
  projectRoot: null,
  framework: 'generic-php', // 'laravel' | 'slim' | 'symfony' | 'generic-php'
};

// ────────────────────────────────────────────
// 1. VENTANA PRINCIPAL — BrowserWindow con custom titlebar
//    Configura frame, preload, seguridad y DevTools
// ────────────────────────────────────────────
/**
 * Lee el tema activo del archivo de configuración compartido y devuelve
 * el color de fondo correspondiente para BrowserWindow.backgroundColor.
 *
 * Se ejecuta ANTES de crear la ventana para que Electron muestre el
 * color correcto desde el primer frame, evitando el flash del tema dark
 * por defecto al usar temas custom o light.
 *
 * @returns {{ bg: string, theme: string, vars: object|null }}
 */
function getInitialThemeInfo() {
  const themeConfig = getThemeConfig();
  const active = themeConfig.activeTheme || 'dark';
  if (active === 'dark') return { bg: '#0d1a2a', theme: 'dark', vars: null };
  if (active === 'light') return { bg: '#F4E2CE', theme: 'light', vars: null };
  // Custom theme: buscar el color de fondo en los temas guardados
  const custom = (themeConfig.customThemes || []).find(t => t.id === active);
  if (custom?.vars) {
    return { bg: custom.colors?.bg || '#0d1a2a', theme: active, vars: custom.vars };
  }
  return { bg: custom?.colors?.bg || '#0d1a2a', theme: active, vars: null };
}

function createWindow() {
  const initialTheme = getInitialThemeInfo();
  mainWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: initialTheme.bg,
    show: false,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      // preload.js actúa como puente seguro entre main y renderer
      preload: path.join(__dirname, 'preload.js'),
      // SEGURIDAD: nunca poner nodeIntegration: true en producción
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Necesario para node-pty
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // ── Mostrar ventana solo después de que el tema esté aplicado ──
  // El renderer envía 'theme:ready' tras aplicar el custom theme.
  // Fallback de 3s por si el IPC no llega (e.g. error en renderer).
  const showOnce = () => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); };
  ipcMain.once('theme:ready', showOnce);
  setTimeout(showOnce, 3000);

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const proc of ptyProcesses.values()) {
      try { proc.kill(); } catch { /* already exited */ }
    }
    ptyProcesses.clear();
  });
}

/**
 * Abre una nueva instancia independiente de MojaveCode.
 * Cada ventana es un proceso separado con su propio LSP,
 * terminales, debugger y estado de proyecto.
 */
function spawnNewWindow() {
  spawn(process.execPath, [app.getAppPath()], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MOJAVECODE_NEW_WINDOW: '1' },
  }).unref();
}

// ────────────────────────────────────────────
// 2. MENÚ NATIVO — Barra superior de macOS
//    File, Edit, View, Terminal, Git, Composer, Artisan*, PHP*, Tema, Help
//    (* = dinámicos, aparecen solo si se detectan en el proyecto)
// ────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder...',
          accelerator: 'CmdOrCtrl+O',
          click: () => handleOpenFolder(),
        },
        {
          label: 'Open File...',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => handleOpenFile(),
        },
        // Submenú de carpetas recientes.
        // Se construye dinámicamente cada vez que se llama createMenu().
        // Cada item muestra el nombre de la carpeta como label y la ruta
        // abreviada como sublabel. Al clickear, abre la carpeta directo.
        {
          label: 'Open Recent',
          submenu: (() => {
            const recent = getRecentFolders();
            if (!recent.length) return [{ label: 'No Recent Folders', enabled: false }];
            const items = recent.map((folderPath) => ({
              label: folderPath.split(/[/\\]/).pop(),
              sublabel: abbreviateHome(folderPath),
              click: () => {
                saveRecentFolder(folderPath);
                mainWindow?.webContents.send('folder:opened', folderPath);
              },
            }));
            items.push(
              { type: 'separator' },
              {
                label: 'Clear Recent',
                click: () => {
                  try { fs.writeFileSync(RECENT_FILE, '[]', 'utf-8'); } catch {}
                  createMenu(); // Reconstruir para vaciar el submenú
                },
              }
            );
            return items;
          })(),
        },
        { type: 'separator' },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => spawnNewWindow(),
        },
        { type: 'separator' },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          label: 'Save As...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
        { type: 'separator' },
        // Auto Save: guarda automáticamente 1s después del último cambio.
        // El estado se mantiene en projectCapabilities y se sincroniza
        // con el renderer vía IPC para que el debounce funcione allá.
        {
          label: 'Auto Save',
          type: 'checkbox',
          checked: projectCapabilities.autoSave,
          click: (menuItem) => {
            projectCapabilities.autoSave = menuItem.checked;
            mainWindow?.webContents.send('menu:auto-save-changed', menuItem.checked);
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => mainWindow?.webContents.send('menu:toggle-sidebar'),
        },
        {
          label: 'Toggle Terminal',
          accelerator: 'CmdOrCtrl+`',
          click: () => mainWindow?.webContents.send('menu:toggle-terminal'),
        },
        {
          label: 'Search in Files',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => mainWindow?.webContents.send('menu:search'),
        },
        {
          label: 'Go to Symbol in Project...',
          accelerator: 'CmdOrCtrl+T',
          click: () => mainWindow?.webContents.send('menu:go-to-symbol'),
        },
        { type: 'separator' },
        {
          label: 'Database Viewer',
          click: () => mainWindow?.webContents.send('menu:db-viewer'),
        },
        ...((projectCapabilities.hasArtisan || projectCapabilities.framework === 'slim') ? [{
          label: 'Route List',
          click: () => mainWindow?.webContents.send('menu:route-list'),
        }] : []),
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => mainWindow?.webContents.send('menu:zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu:zoom-out'),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.send('menu:zoom-reset'),
        },
        { type: 'separator' },
        {
          label: 'UI Zoom In (Panels)',
          accelerator: 'CmdOrCtrl+Alt+=',
          click: () => mainWindow?.webContents.send('menu:ui-zoom-in'),
        },
        {
          label: 'UI Zoom Out (Panels)',
          accelerator: 'CmdOrCtrl+Alt+-',
          click: () => mainWindow?.webContents.send('menu:ui-zoom-out'),
        },
        {
          label: 'UI Zoom Reset (Panels)',
          accelerator: 'CmdOrCtrl+Alt+0',
          click: () => mainWindow?.webContents.send('menu:ui-zoom-reset'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'New Terminal',
          accelerator: 'CmdOrCtrl+Shift+`',
          click: () => mainWindow?.webContents.send('menu:new-terminal'),
        },
      ],
    },
    // ── Git Menu ──
    // Operaciones de git que no requieren el panel lateral.
    // Switch Branch abre una paleta de búsqueda en el renderer
    // para cambiar de rama sin tocar la terminal.
    {
      label: 'Git',
      submenu: [
        {
          label: 'Switch Branch...',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => mainWindow?.webContents.send('menu:git-checkout'),
        },
      ],
    },
    // ── Tema Menu ──
    // Combina los 2 temas built-in (Dark/Light) con los temas custom
    // que el usuario haya generado. Los custom se sincronizan desde el
    // renderer via IPC 'theme:syncCustom' al iniciar y al crear/eliminar.
    //
    // Estructura del menú:
    // - Mojave Dark (radio)
    // - Mojave Light (radio)
    // - ── separator (solo si hay custom) ──
    // - [Temas custom como radio buttons]
    // - ── separator ──
    // - Generate Theme... (abre el diálogo en el renderer)
    // - Delete Theme > [submenu] (solo si hay custom)
    {
      label: 'Tema',
      submenu: [
        {
          label: 'Mojave Dark',
          type: 'radio',
          checked: true,
          click: () => mainWindow?.webContents.send('menu:switch-theme', 'dark'),
        },
        {
          label: 'Mojave Light',
          type: 'radio',
          click: () => mainWindow?.webContents.send('menu:switch-theme', 'light'),
        },
        // Temas custom del usuario (sincronizados desde localStorage del renderer)
        ...(customThemeEntries.length > 0 ? [
          { type: 'separator' },
          ...customThemeEntries.map(t => ({
            label: t.name,
            type: 'radio',
            click: () => mainWindow?.webContents.send('menu:switch-theme', t.id),
          })),
        ] : []),
        { type: 'separator' },
        {
          label: 'Generate Theme...',
          click: () => mainWindow?.webContents.send('menu:generate-theme'),
        },
        // Submenu para eliminar temas custom (solo si hay alguno creado)
        ...(customThemeEntries.length > 0 ? [{
          label: 'Delete Theme',
          submenu: customThemeEntries.map(t => ({
            label: t.name,
            click: () => mainWindow?.webContents.send('menu:delete-theme', t.id),
          })),
        }] : []),
      ],
    },
    // ── Composer Menu ──
    // Siempre visible en la barra para que "New Laravel Project"
    // esté disponible incluso sin un proyecto abierto.
    // Los comandos de proyecto (install, require, etc.) solo
    // aparecen cuando se detecta un composer.json en la carpeta.
    {
      label: 'Composer',
      submenu: [
        {
          label: 'New Laravel Project...',
          click: () => mainWindow?.webContents.send('composer:new-laravel'),
        },
        ...(projectCapabilities.hasComposer ? [
          // Toggle Sail — solo visible cuando el proyecto tiene vendor/bin/sail
          ...(projectCapabilities.hasSail ? [
            {
              label: 'Run via Sail',
              type: 'checkbox',
              checked: projectCapabilities.sailEnabled,
              click: (menuItem) => {
                projectCapabilities.sailEnabled = menuItem.checked;
                createMenu();
                mainWindow?.webContents.send('sail:changed', projectCapabilities.sailEnabled);
              },
            },
          ] : []),
          { type: 'separator' },
          {
            label: 'Install',
            click: () => mainWindow?.webContents.send('composer:run', 'install'),
          },
          {
            label: 'Update',
            click: () => mainWindow?.webContents.send('composer:run', 'update'),
          },
          { type: 'separator' },
          {
            label: 'Require Package...',
            click: () => mainWindow?.webContents.send('composer:prompt', 'require'),
          },
          {
            label: 'Require Dev Package...',
            click: () => mainWindow?.webContents.send('composer:prompt', 'require --dev'),
          },
          {
            label: 'Remove Package...',
            click: () => mainWindow?.webContents.send('composer:prompt', 'remove'),
          },
          { type: 'separator' },
          {
            label: 'Dump Autoload',
            click: () => mainWindow?.webContents.send('composer:run', 'dump-autoload'),
          },
          {
            label: 'Run Script...',
            click: () => mainWindow?.webContents.send('composer:prompt', 'run-script'),
          },
        ] : []),
      ],
    },
    // ── Artisan Menu (dinámico) ──
    ...(projectCapabilities.hasArtisan ? [{
      label: 'Artisan',
      submenu: [
        {
          label: 'Make',
          submenu: [
            { label: 'Model...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:model') },
            { label: 'Controller...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:controller') },
            { label: 'Migration...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:migration') },
            { label: 'Seeder...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:seeder') },
            { label: 'Factory...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:factory') },
            { label: 'Middleware...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:middleware') },
            { label: 'Request...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:request') },
            { label: 'Resource...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:resource') },
            { label: 'Event...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:event') },
            { label: 'Listener...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:listener') },
            { label: 'Job...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:job') },
            { label: 'Mail...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:mail') },
            { label: 'Notification...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:notification') },
            { label: 'Policy...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:policy') },
            { label: 'Command...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:command') },
            { label: 'Test...', click: () => mainWindow?.webContents.send('artisan:prompt', 'make:test') },
          ],
        },
        { type: 'separator' },
        {
          label: 'Migrate',
          submenu: [
            { label: 'Run Migrations', click: () => mainWindow?.webContents.send('artisan:run', 'migrate') },
            { label: 'Rollback', click: () => mainWindow?.webContents.send('artisan:run', 'migrate:rollback') },
            { label: 'Fresh (Drop & Migrate)', click: () => mainWindow?.webContents.send('artisan:run', 'migrate:fresh') },
            { label: 'Status', click: () => mainWindow?.webContents.send('artisan:run', 'migrate:status') },
          ],
        },
        {
          label: 'Cache',
          submenu: [
            { label: 'Clear App Cache', click: () => mainWindow?.webContents.send('artisan:run', 'cache:clear') },
            { label: 'Clear Config Cache', click: () => mainWindow?.webContents.send('artisan:run', 'config:clear') },
            { label: 'Clear Route Cache', click: () => mainWindow?.webContents.send('artisan:run', 'route:clear') },
            { label: 'Clear View Cache', click: () => mainWindow?.webContents.send('artisan:run', 'view:clear') },
            { type: 'separator' },
            { label: 'Cache Config', click: () => mainWindow?.webContents.send('artisan:run', 'config:cache') },
            { label: 'Cache Routes', click: () => mainWindow?.webContents.send('artisan:run', 'route:cache') },
          ],
        },
        { type: 'separator' },
        {
          label: 'Route List',
          click: () => mainWindow?.webContents.send('artisan:run', 'route:list'),
        },
        {
          label: 'Tinker',
          click: () => mainWindow?.webContents.send('artisan:tinker'),
        },
        { type: 'separator' },
        {
          label: 'Run Custom Command...',
          click: () => mainWindow?.webContents.send('artisan:prompt', ''),
        },
        // ── Sail toggle ──
        ...(projectCapabilities.hasSail ? [
          { type: 'separator' },
          {
            label: 'Run via Sail',
            type: 'checkbox',
            checked: projectCapabilities.sailEnabled,
            click: (menuItem) => {
              projectCapabilities.sailEnabled = menuItem.checked;
              createMenu();
              mainWindow?.webContents.send('sail:changed', projectCapabilities.sailEnabled);
            },
          },
        ] : []),
        // ── Laravel Modules submenu ──
        ...(projectCapabilities.hasModules ? [
          { type: 'separator' },
          {
            label: 'Modules',
            submenu: [
              { label: 'List Modules', click: () => mainWindow?.webContents.send('artisan:run', 'module:list') },
              { type: 'separator' },
              { label: 'Make Module...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make') },
              { label: 'Make Module Model...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-model') },
              { label: 'Make Module Controller...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-controller') },
              { label: 'Make Module Migration...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-migration') },
              { label: 'Make Module Seeder...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-seeder') },
              { label: 'Make Module Request...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-request') },
              { label: 'Make Module Command...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-command') },
              { label: 'Make Module Event...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-event') },
              { label: 'Make Module Job...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-job') },
              { label: 'Make Module Middleware...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-middleware') },
              { label: 'Make Module Provider...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-provider') },
              { label: 'Make Module Test...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:make-test') },
              { type: 'separator' },
              { label: 'Module Migrate...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:migrate') },
              { label: 'Module Seed...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:seed') },
              { label: 'Enable Module...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:enable') },
              { label: 'Disable Module...', click: () => mainWindow?.webContents.send('artisan:prompt', 'module:disable') },
            ],
          },
        ] : []),
      ],
    }] : []),
    // ── PHP Menu (format on save + PHPUnit) ──
    ...((projectCapabilities.hasPint || projectCapabilities.hasCsFixer || projectCapabilities.hasPhpUnit) ? [{
      label: 'PHP',
      submenu: [
        // Format on save toggle
        ...((projectCapabilities.hasPint || projectCapabilities.hasCsFixer) ? [
          {
            label: `Format on Save (${projectCapabilities.hasPint ? 'Pint' : 'CS Fixer'})`,
            type: 'checkbox',
            checked: projectCapabilities.formatOnSave,
            click: (menuItem) => {
              projectCapabilities.formatOnSave = menuItem.checked;
              mainWindow?.webContents.send('php:formatOnSaveChanged', menuItem.checked);
            },
          },
          { type: 'separator' },
        ] : []),
        // PHPUnit
        ...(projectCapabilities.hasPhpUnit ? [
          {
            label: 'Run All Tests',
            click: () => mainWindow?.webContents.send('phpunit:runAll'),
          },
          {
            label: 'Run Current File',
            click: () => mainWindow?.webContents.send('phpunit:runFile'),
          },
          {
            label: 'Run Current Method',
            click: () => mainWindow?.webContents.send('phpunit:runMethod'),
          },
        ] : []),
      ],
    }] : []),
    {
      label: 'Help',
      submenu: [
        {
          label: 'About MojaveCode PHP',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'MojaveCode PHP',
              message: 'MojaveCode PHP v3.7.0',
              detail: 'A lightweight code editor by MojaveWare.\nBuilt with Electron + Monaco + xterm.js',
            });
          },
        },
        {
          label: 'MojaveWare Website',
          click: () => shell.openExternal('https://mojaveware.com'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // ── Enviar estructura del menú al renderer (Windows/Linux hamburger menu) ──
  // En macOS el menú nativo es suficiente. En Windows/Linux no hay barra de
  // menú nativa con frame:false, así que el renderer dibuja un menú propio.
  if (process.platform !== 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    const menuData = serializeMenu(menu);
    mainWindow.webContents.send('menu:structure', menuData);
  }
}

/**
 * Serializa el menú de Electron a un array plano para el renderer.
 * Solo incluye label, accelerator, type, enabled, checked y submenu.
 * Los callbacks (click) se ejecutan via 'menu:execute' IPC.
 */
function serializeMenu(menu) {
  return menu.items
    .filter(item => item.visible !== false)
    .map(item => serializeMenuItem(item));
}

/**
 * Serializa un MenuItem recursivamente.
 * Convierte accelerators de Electron (CmdOrCtrl) al formato de la plataforma.
 *
 * @param {Electron.MenuItem} item
 * @returns {{ label: string, type: string, enabled: boolean, checked: boolean, accelerator?: string, submenu?: array }}
 */
function serializeMenuItem(item) {
  const result = {
    label: item.label || '',
    type: item.type || 'normal',
    enabled: item.enabled !== false,
    checked: !!item.checked,
  };
  if (item.accelerator) {
    result.accelerator = item.accelerator
      .replace('CmdOrCtrl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
      .replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
  }
  if (item.submenu && item.submenu.items) {
    result.submenu = item.submenu.items
      .filter(sub => sub.visible !== false)
      .map(sub => serializeMenuItem(sub));
  }
  return result;
}

// ────────────────────────────────────────────
// 2b. DETECCIÓN DE PROYECTO — Composer, Artisan, Laravel Modules
//     Escanea el root del proyecto para habilitar menús dinámicos
// ────────────────────────────────────────────
function detectProjectCapabilities(folderPath) {
  projectCapabilities.projectRoot = folderPath;
  projectCapabilities.hasComposer = fs.existsSync(path.join(folderPath, 'composer.json'));
  projectCapabilities.hasArtisan = fs.existsSync(path.join(folderPath, 'artisan'));

  // ── Detectar framework y dependencias desde composer.json ──
  projectCapabilities.hasModules = false;
  projectCapabilities.framework = 'generic-php';
  if (projectCapabilities.hasComposer) {
    try {
      const composerJson = JSON.parse(fs.readFileSync(path.join(folderPath, 'composer.json'), 'utf-8'));
      const allDeps = { ...composerJson.require, ...composerJson['require-dev'] };

      // Framework detection por dependencia principal
      if (allDeps['laravel/framework'] || projectCapabilities.hasArtisan) {
        projectCapabilities.framework = 'laravel';
      } else if (allDeps['slim/slim']) {
        projectCapabilities.framework = 'slim';
      } else if (allDeps['symfony/framework-bundle'] || allDeps['symfony/symfony']) {
        projectCapabilities.framework = 'symfony';
      }

      // nwidart/laravel-modules
      if (allDeps['nwidart/laravel-modules']) {
        projectCapabilities.hasModules = true;
      }
    } catch { /* ignore parse errors */ }
  }

  // Detectar PHP formatter (Pint o CS Fixer)
  projectCapabilities.hasPint = fs.existsSync(path.join(folderPath, 'pint.json'))
    || fs.existsSync(path.join(folderPath, 'vendor', 'bin', 'pint'));
  projectCapabilities.hasCsFixer = fs.existsSync(path.join(folderPath, '.php-cs-fixer.php'))
    || fs.existsSync(path.join(folderPath, '.php-cs-fixer.dist.php'));

  // Detectar PHPUnit
  projectCapabilities.hasPhpUnit = fs.existsSync(path.join(folderPath, 'phpunit.xml'))
    || fs.existsSync(path.join(folderPath, 'phpunit.xml.dist'));

  // Detectar Docker — buscar docker-compose.yml subiendo directorios.
  // Busca TODOS los compose subiendo desde el proyecto hasta la raíz.
  // Usa el primero que tenga container_name + volume mapping válido.
  // Un compose de Sail típicamente NO tiene container_name, así que se
  // salta y se encuentra el Docker custom del directorio padre.
  projectCapabilities.hasDocker = false;
  projectCapabilities.dockerEnv = false;
  projectCapabilities.dockerContainer = null;
  projectCapabilities.dockerWorkdir = null;

  let parentDockerCoversProject = false;
  const composePaths = findAllDockerCompose(folderPath);
  for (const composePath of composePaths) {
    const dockerConfig = parseDockerConfig(composePath, folderPath);
    if (dockerConfig) {
      projectCapabilities.hasDocker = true;
      projectCapabilities.dockerContainer = dockerConfig.containerName;
      projectCapabilities.dockerWorkdir = dockerConfig.workdir;
      const composeInParent = path.dirname(composePath) !== folderPath;
      if (composeInParent) parentDockerCoversProject = true;
      break;
    }
  }
  // Si encontramos compose(s) pero ninguno tuvo config válida, marcar hasDocker
  if (!projectCapabilities.hasDocker && composePaths.length > 0) {
    projectCapabilities.hasDocker = true;
  }

  // También detectar si .env tiene host.docker.internal (proyecto conecta a servicios vía Docker)
  const envPath = path.join(folderPath, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const envContent = fs.readFileSync(envPath, 'utf-8');
      projectCapabilities.dockerEnv = envContent.includes('host.docker.internal');
      // Si hay host.docker.internal pero no encontramos docker-compose, intentar buscar
      if (projectCapabilities.dockerEnv && !projectCapabilities.hasDocker) {
        projectCapabilities.hasDocker = true;
      }
    } catch { /* ignore read errors */ }
  }

  // Detectar Laravel Sail (vendor/bin/sail)
  // Solo considerar Sail si NO hay un docker-compose padre que ya cubra el proyecto.
  // Un proyecto puede tener vendor/bin/sail instalado como dependencia de Composer
  // pero correr con un Docker custom desde un directorio padre.
  const hasSailFiles = fs.existsSync(path.join(folderPath, 'vendor', 'bin', 'sail'))
    && fs.existsSync(path.join(folderPath, 'docker-compose.yml'));
  projectCapabilities.hasSail = hasSailFiles && !parentDockerCoversProject;
  projectCapabilities.sailEnabled = projectCapabilities.hasSail;

  // ── Detectar Claude CLI en PATH ─────────────────────────────────
  // Habilita el botón "Ask Claude" en el Error Log para enviar errores
  // directamente al CLI de Claude desde la terminal integrada.
  projectCapabilities.hasClaude = false;
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    require('child_process').execSync(cmd, { stdio: 'ignore' });
    projectCapabilities.hasClaude = true;
  } catch { /* claude not in PATH */ }

  // Reset format on save al cambiar de proyecto
  projectCapabilities.formatOnSave = false;

  // Rebuild menu con los items detectados
  createMenu();

  // Notificar al renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('project:capabilities', projectCapabilities);
  }
}

// ── Docker helpers ──

/**
 * Buscar TODOS los docker-compose.yml subiendo directorios desde folderPath.
 *
 * Retorna un array de rutas ordenadas de local a padre. Esto permite
 * distinguir entre un compose de Sail (local, sin container_name) y
 * un Docker custom (padre, con container_name + volumes).
 *
 * @param {string} folderPath - Directorio raíz del proyecto
 * @returns {string[]} Rutas a los archivos docker-compose encontrados
 */
function findAllDockerCompose(folderPath) {
  const found = [];
  let dir = folderPath;
  const root = path.parse(dir).root;
  while (dir !== root) {
    for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
    dir = path.dirname(dir);
  }
  return found;
}

/**
 * Parsear docker-compose.yml para extraer container_name y volumes del primer servicio.
 * Retorna { containerName, workdir } o null.
 */
function parseDockerConfig(composePath, projectRoot) {
  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    const composeDir = path.dirname(composePath);

    // Extraer container_name
    const nameMatch = content.match(/container_name:\s*["']?([^\s"']+)/);
    if (!nameMatch) return null;
    const containerName = nameMatch[1];

    // Extraer volumes para calcular workdir dentro del contenedor
    // Buscar patrones como ./src:/var/www/html
    const volumeRegex = /- ["']?(\.[^:]+):([^"'\s]+)/g;
    let workdir = null;
    let match;
    while ((match = volumeRegex.exec(content)) !== null) {
      const hostPath = path.resolve(composeDir, match[1]);
      const containerPath = match[2];
      // Si el projectRoot está dentro del volume source, calcular el workdir
      if (projectRoot.startsWith(hostPath)) {
        const relative = path.relative(hostPath, projectRoot);
        workdir = relative ? path.posix.join(containerPath, relative) : containerPath;
        break;
      }
    }

    return workdir ? { containerName, workdir } : null;
  } catch {
    return null;
  }
}

/**
 * Ejecutar un comando en el proyecto. Si Docker está activo, lo ejecuta
 * dentro del contenedor via `docker exec`.
 * Devuelve { output, error, code }
 */
/**
 * Ejecutar un comando en el proyecto respetando el entorno activo.
 *
 * Orden de prioridad:
 *  1. Laravel Sail  — si `hasSail && sailEnabled`, usa `./vendor/bin/sail`
 *  2. Docker exec   — si hay container+workdir detectados, usa `docker exec`
 *  3. Local         — ejecución directa sin contenedor
 *
 * Sail toma prioridad porque es más confiable que `docker exec` para proyectos
 * Laravel: no requiere que el container tenga un nombre fijo ni mapeo de volumes.
 *
 * @param {string} cmd  - 'composer' o 'php' (artisan usa php)
 * @param {string[]} args
 * @param {string} cwd
 */
function runProjectCommand(cmd, args, cwd) {
  const { hasSail, sailEnabled, dockerContainer, dockerWorkdir } = projectCapabilities;

  // ── Sail (prioridad alta) ─────────────────────────────────────
  if (hasSail && sailEnabled) {
    // sail composer <args>  o  sail artisan <subcommand> <args>
    // Para Artisan: cmd='php', args=['artisan', subcommand, ...]
    //   → ./vendor/bin/sail artisan subcommand ...
    // Para Composer: cmd='composer', args=[subcommand, ...]
    //   → ./vendor/bin/sail composer subcommand ...
    //
    // En Windows: vendor/bin/sail es un bash script que no corre en
    // PowerShell. Usamos `php vendor/bin/sail` como wrapper.
    const isWin = process.platform === 'win32';
    const sailBin = isWin ? 'php' : './vendor/bin/sail';
    const sailPrefix = isWin ? [path.join('vendor', 'bin', 'sail')] : [];
    if (cmd === 'php' && args[0] === 'artisan') {
      return runCommand(sailBin, [...sailPrefix, ...args], cwd);
    }
    if (cmd === 'composer') {
      return runCommand(sailBin, [...sailPrefix, cmd, ...args], cwd);
    }
  }

  // ── Docker exec genérico ──────────────────────────────────────
  if (dockerContainer && dockerWorkdir) {
    const dockerArgs = ['exec', '-w', dockerWorkdir, dockerContainer, cmd, ...args];
    return runCommand('docker', dockerArgs, cwd);
  }

  // ── Ejecución local directa ───────────────────────────────────
  return runCommand(cmd, args, cwd);
}

/**
 * Ejecutar un comando del SO (composer, php artisan, etc.)
 *
 * En Windows usa shell:true para que cmd.exe resuelva .bat/.cmd
 * (composer.bat, pint.bat, etc.). En Unix execFile ejecuta directamente.
 *
 * @param {string} cmd - Comando a ejecutar
 * @param {string[]} args - Argumentos
 * @param {string} cwd - Directorio de trabajo
 * @returns {Promise<{ output: string, error: string|null, code: number }>}
 */
function runCommand(cmd, args, cwd) {
  const opts = {
    cwd,
    maxBuffer: config.exec.maxBuffer,
    timeout: config.exec.timeout,
    // Windows: shell:true para que cmd.exe resuelva .bat/.cmd (composer, pint, etc.)
    ...(process.platform === 'win32' ? { shell: true } : {}),
  };
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        resolve({ output: stdout, error: stderr || err.message, code: err.code });
      } else {
        resolve({ output: stdout, error: stderr || null, code: 0 });
      }
    });
  });
}

// ────────────────────────────────────────────
// 3. IPC HANDLERS — FILESYSTEM (lectura/escritura de archivos)
//    readDir, listAllFiles, readFile, writeFile, stat
// ────────────────────────────────────────────
// Estos handlers responden a mensajes del renderer.
// El renderer llama: window.api.readDir('/some/path')
// Eso llega acá via ipcMain.handle('fs:readDir', ...)

/**
 * Leer el contenido de un directorio.
 * Devuelve un array de { name, path, isDirectory, extension }
 */
ipcMain.handle('fs:readDir', async (event, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => !(entry.name.startsWith('.') && entry.isDirectory())) // Ocultar dot-directories (.git, etc), mostrar dotfiles (.env, .gitignore)
      .sort((a, b) => {
        // Carpetas primero, después archivos
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => ({
        name: entry.name,
        path: path.join(dirPath, entry.name),
        isDirectory: entry.isDirectory(),
        extension: path.extname(entry.name).slice(1),
      }));
  } catch (err) {
    console.error('readDir error:', err);
    return [];
  }
});

/**
 * Listar todos los archivos recursivamente (para Quick Open).
 * Ignora node_modules, .git, y dotfiles.
 */
ipcMain.handle('fs:listAllFiles', async (event, rootDir) => {
  const results = [];
  const MAX_FILES = config.search.maxFiles;
  const MAX_DEPTH = config.search.maxDepth;

  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_FILES) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || config.ignore.dirs.has(entry.name)) continue;
        await walk(fullPath, depth + 1);
      } else {
        results.push(fullPath);
      }
    }
  }

  await walk(rootDir, 0);
  return results;
});

/**
 * Leer el contenido de un archivo (como texto UTF-8)
 */
ipcMain.handle('fs:readFile', async (event, filePath) => {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { content, error: null };
  } catch (err) {
    return { content: null, error: err.message };
  }
});

/**
 * Escribir contenido a un archivo
 */
ipcMain.handle('fs:writeFile', async (event, filePath, content) => {
  try {
    // Marcar el archivo antes de escribir para que el watcher lo ignore.
    // fs.watch dispara cuando escribimos nosotros también — esto evita el
    // falso positivo de "archivo cambió externamente" tras un Cmd+S.
    markRecentlySaved(filePath);
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ────────────────────────────────────────────────────────────────
// FILE WATCHER — detectar cambios externos en archivos abiertos
// ────────────────────────────────────────────────────────────────
//
// Observa los archivos que el renderer tiene abiertos en tabs.
// Cuando un proceso externo los modifica (git checkout, artisan,
// un formatter corriendo fuera del editor, etc.) notificamos al
// renderer para que ofrezca recargar el contenido.
//
// DETALLES DE IMPLEMENTACIÓN:
// ─────────────────────────────
// • Usa fs.watch() por archivo — sin dependencias extra.
// • fs.watch() puede disparar 2–3 veces por un solo guardado en
//   macOS (evento 'rename' + 'change'). Debounce de 300ms lo filtra.
// • Cuando somos nosotros quienes escribimos (fs:writeFile), llamamos
//   markRecentlySaved() para ignorar el evento durante 1 segundo.
// • Al cerrar el proyecto (watch:clear) todos los watchers se destruyen.

const fileWatchers   = new Map(); // filePath → FSWatcher
const watchDebounce  = new Map(); // filePath → timer de debounce
const recentlySaved  = new Set(); // archivos que acabamos de escribir nosotros

/**
 * Registra que acabamos de escribir este archivo.
 * El watcher lo ignorará durante 1 segundo para evitar el falso positivo.
 *
 * @param {string} filePath
 */
function markRecentlySaved(filePath) {
  recentlySaved.add(filePath);
  setTimeout(() => recentlySaved.delete(filePath), 1000);
}

/**
 * Empieza a observar un archivo. Si ya está siendo observado, no hace nada.
 * Cuando detecta un cambio externo, envía 'file:changed' al renderer.
 *
 * NOTA SOBRE macOS Y RENAME:
 * ──────────────────────────
 * Muchos editores y herramientas (vim, git, formatters) guardan archivos
 * con un patrón atómico: escriben a un temp y luego renombran sobre el
 * original. Esto dispara un evento 'rename' en fs.watch() y deja el
 * watcher muerto (apuntaba al inode viejo que ya no existe en esa ruta).
 *
 * Para solucionarlo: al recibir 'rename', cerramos el watcher viejo y
 * recreamos uno nuevo tras un breve delay (para que el archivo ya exista
 * en su ubicación final).
 */
function startFileWatcher(filePath) {
  // Limpiar watcher previo si existe
  const oldWatcher = fileWatchers.get(filePath);
  if (oldWatcher) {
    try { oldWatcher.close(); } catch {}
    fileWatchers.delete(filePath);
  }

  if (!fs.existsSync(filePath)) return;

  try {
    const watcher = fs.watch(filePath, (eventType) => {
      if (recentlySaved.has(filePath)) return;

      if (eventType === 'rename') {
        // El archivo fue reemplazado (atomic save) — el watcher actual
        // ya no sirve. Recrear después de un breve delay para que el
        // nuevo archivo ya exista en disco.
        clearTimeout(watchDebounce.get(filePath));
        watchDebounce.set(filePath, setTimeout(() => {
          watchDebounce.delete(filePath);
          startFileWatcher(filePath);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file:changed', filePath);
          }
        }, 300));
        return;
      }

      // eventType === 'change' — modificación in-place normal
      clearTimeout(watchDebounce.get(filePath));
      watchDebounce.set(filePath, setTimeout(() => {
        watchDebounce.delete(filePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file:changed', filePath);
        }
      }, 300));
    });

    watcher.on('error', () => {
      fileWatchers.delete(filePath);
      watchDebounce.delete(filePath);
    });

    fileWatchers.set(filePath, watcher);
  } catch {
    // El archivo puede no existir todavía — ignorar silenciosamente
  }
}

ipcMain.handle('watch:add', (event, filePath) => {
  if (fileWatchers.has(filePath)) return;
  startFileWatcher(filePath);
});

/**
 * Deja de observar un archivo y limpia sus timers pendientes.
 */
ipcMain.handle('watch:remove', (event, filePath) => {
  const watcher = fileWatchers.get(filePath);
  if (watcher) {
    try { watcher.close(); } catch {}
    fileWatchers.delete(filePath);
  }
  clearTimeout(watchDebounce.get(filePath));
  watchDebounce.delete(filePath);
});

/**
 * Destruye todos los watchers activos. Se llama al cerrar un proyecto.
 */
ipcMain.handle('watch:clear', () => {
  for (const watcher of fileWatchers.values()) {
    try { watcher.close(); } catch {}
  }
  fileWatchers.clear();
  for (const timer of watchDebounce.values()) clearTimeout(timer);
  watchDebounce.clear();
  recentlySaved.clear();
});

/**
 * Obtener info de un archivo (size, mtime, etc.)
 */
ipcMain.handle('fs:stat', async (event, filePath) => {
  try {
    const stat = await fs.promises.stat(filePath);
    return {
      size: stat.size,
      isDirectory: stat.isDirectory(),
      modified: stat.mtime.toISOString(),
    };
  } catch (err) {
    return null;
  }
});

/**
 * Eliminar un archivo o carpeta del disco.
 *
 * Si es carpeta usa `rm` recursivo; si es archivo usa `unlink`.
 * El renderer llama esto desde el context menu del file tree
 * después de que el usuario confirma la eliminación.
 */
ipcMain.handle('fs:deleteFile', async (event, targetPath) => {
  try {
    const stat = await fs.promises.stat(targetPath);
    if (stat.isDirectory()) {
      await fs.promises.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(targetPath);
    }
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Crear un archivo vacío en disco.
 *
 * Usa el flag 'wx' (write exclusive) que falla si el archivo
 * ya existe, evitando sobrescrituras accidentales.
 * El renderer llama esto desde el inline input del file tree
 * después de que el usuario escribe el nombre.
 */
ipcMain.handle('fs:createFile', async (event, filePath) => {
  try {
    await fs.promises.writeFile(filePath, '', { flag: 'wx' });
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Crear un directorio en disco.
 *
 * Usa `recursive: true` para crear directorios intermedios
 * si el usuario escribe un path anidado (ej: "src/utils/helpers").
 * No falla si el directorio ya existe.
 */
ipcMain.handle('fs:createDir', async (event, dirPath) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:copyFile', async (event, srcPath, destPath) => {
  try {
    const stat = await fs.promises.stat(srcPath);
    if (stat.isDirectory()) {
      await fs.promises.cp(srcPath, destPath, { recursive: true });
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Renombrar archivo o carpeta (usado por el context menu del file tree)
ipcMain.handle('fs:rename', async (event, oldPath, newPath) => {
  try {
    await fs.promises.rename(oldPath, newPath);
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * Listar los archivos de log en storage/logs.
 *
 * Lee el directorio storage/logs del proyecto Laravel
 * y devuelve todos los archivos (no solo laravel.log).
 * Ordenados alfabéticamente descendente para que los
 * más recientes aparezcan primero (ej: laravel-2024-03-16.log).
 */
ipcMain.handle('fs:listLogs', async (event) => {
  if (!projectCapabilities.projectRoot) {
    return { files: [], error: 'No project open' };
  }
  const logsDir = path.join(projectCapabilities.projectRoot, 'storage', 'logs');
  try {
    const entries = await fs.promises.readdir(logsDir, { withFileTypes: true });
    const logFiles = entries
      .filter((e) => !e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(logsDir, e.name),
      }))
      .sort((a, b) => b.name.localeCompare(a.name)); // Más recientes primero
    return { files: logFiles, error: null };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

/**
 * Leer las últimas N líneas de un archivo de log.
 *
 * En vez de leer todo el archivo (que puede ser enorme),
 * solo devuelve las últimas `lines` líneas. El renderer
 * parsea estas líneas y las muestra formateadas con colores
 * según el nivel (ERROR, WARNING, INFO, DEBUG).
 */
ipcMain.handle('fs:readLogTail', async (event, filePath, lines = 500) => {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const allLines = content.split(/\r?\n/);
    const tail = allLines.slice(-lines).join('\n');
    return { content: tail, totalLines: allLines.length, error: null };
  } catch (err) {
    return { content: null, totalLines: 0, error: err.message };
  }
});

// Cuando el renderer abre una carpeta reciente desde la welcome screen,
// nos avisa para mantener sincronizados los dos storages:
// - localStorage del renderer (para la welcome screen)
// - recent-folders.json del main (para el menú nativo File > Open Recent)
ipcMain.on('recent:opened', (event, folderPath) => {
  saveRecentFolder(folderPath);
  createMenu(); // Reconstruir para que la carpeta suba al tope del submenú
});

// ────────────────────────────────────────────
// 4. IPC HANDLERS — DIÁLOGOS NATIVOS DEL SO
//    Open Folder, Open File, Save As
// ────────────────────────────────────────────
async function handleOpenFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) {
    const folderPath = result.filePaths[0];
    // Guardar en recientes y reconstruir el menú para que
    // File > Open Recent refleje la nueva carpeta al tope.
    saveRecentFolder(folderPath);
    createMenu();
    mainWindow.webContents.send('folder:opened', folderPath);
  }
}

async function handleOpenFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'All Files', extensions: ['*'] },
      { name: 'JavaScript', extensions: ['js', 'jsx', 'ts', 'tsx'] },
      { name: 'Web', extensions: ['html', 'css', 'json'] },
      { name: 'PHP', extensions: ['php'] },
    ],
  });
  if (!result.canceled && result.filePaths[0]) {
    mainWindow.webContents.send('file:opened', result.filePaths[0]);
  }
}

ipcMain.handle('dialog:openFolder', handleOpenFolder);
ipcMain.handle('dialog:openFile', handleOpenFile);

ipcMain.handle('dialog:saveAs', async (event, defaultPath) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  if (!result.canceled) {
    return result.filePath;
  }
  return null;
});

// ────────────────────────────────────────────
// 5. IPC HANDLERS — PSEUDO-TERMINAL (node-pty + xterm.js)
//    spawn, write, resize, cd — terminal integrada real
// ────────────────────────────────────────────
/**
 * node-pty crea una pseudo-terminal REAL del SO.
 * Esto significa que podés correr npm, git, python, etc.
 * xterm.js en el renderer se conecta a este pty via IPC.
 *
 * Flujo:
 * 1. Renderer pide 'pty:spawn' → creamos el pty
 * 2. pty emite data → se lo mandamos al renderer via 'pty:data'
 * 3. Renderer escribe en xterm → manda 'pty:write' → escribimos en el pty
 * 4. Renderer pide resize → mandamos 'pty:resize' → resizeamos el pty
 */
/**
 * Crea un nuevo proceso PTY y devuelve su ID numérico.
 * Cada terminal en el renderer tiene su propio pty.
 *
 * @param {string} cwd - Directorio de trabajo inicial
 * @returns {{ id: number, pid: number } | { error: string }}
 */
ipcMain.handle('pty:spawn', (event, cwd) => {
  if (!pty) {
    return { error: 'node-pty not available' };
  }

  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : process.env.SHELL || '/bin/bash';

  try {
    const id = ptyNextId++;
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || os.homedir(),
      env: process.env,
    });

    ptyProcesses.set(id, proc);

    proc.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', id, data);
      }
    });

    proc.onExit(({ exitCode }) => {
      ptyProcesses.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', id, exitCode);
      }
    });

    return { success: true, id, pid: proc.pid };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('pty:write', (event, id, data) => {
  const proc = ptyProcesses.get(id);
  if (proc) proc.write(data);
});

ipcMain.on('pty:resize', (event, id, cols, rows) => {
  const proc = ptyProcesses.get(id);
  if (proc) {
    try { proc.resize(cols, rows); } catch { /* already exited */ }
  }
});

/**
 * Mata un pty específico por su ID.
 */
ipcMain.handle('pty:kill', (event, id) => {
  const proc = ptyProcesses.get(id);
  if (proc) {
    try { proc.kill(); } catch { /* already exited */ }
    ptyProcesses.delete(id);
  }
  return { success: true };
});

/**
 * Mata todos los procesos pty activos. Se usa al cerrar todos los tabs
 * o al cambiar de proyecto.
 */
ipcMain.handle('pty:killAll', () => {
  for (const [id, proc] of ptyProcesses) {
    try { proc.kill(); } catch { /* already exited */ }
  }
  ptyProcesses.clear();
  return { success: true };
});

ipcMain.on('pty:cd', (event, id, cwd) => {
  const proc = ptyProcesses.get(id);
  if (proc && cwd) {
    if (process.platform === 'win32') {
      // PowerShell: escapar comillas dobles
      const safePath = cwd.replace(/"/g, '`"');
      proc.write(`cd "${safePath}"\r\n`);
    } else {
      // Bash/Zsh: escapar comillas simples
      const safePath = cwd.replace(/'/g, "'\\''");
      proc.write(`cd '${safePath}'\n`);
    }
  }
});

// ────────────────────────────────────────────
// 6. IPC HANDLERS — GIT (operaciones de repositorio)
//    branch, status, add, commit, diff, log, graph
// ────────────────────────────────────────────
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: config.exec.maxBuffer, ...(process.platform === 'win32' ? { shell: true } : {}) }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: err.message, stderr });
      } else {
        resolve({ output: stdout.trim() });
      }
    });
  });
}

// Obtener la rama actual
ipcMain.handle('git:branch', async (event, cwd) => {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
});

// Obtener la raíz del repo git
ipcMain.handle('git:rootDir', async (event, cwd) => {
  return runGit(['rev-parse', '--show-toplevel'], cwd);
});

// Verificar si es un repo git
ipcMain.handle('git:isRepo', async (event, cwd) => {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return { isRepo: !result.error };
});

// Obtener status (archivos modificados, staged, untracked)
ipcMain.handle('git:status', async (event, cwd) => {
  // Obtener la raíz del repo para paths absolutos
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], cwd);
  const repoRoot = rootResult.error ? cwd : rootResult.output;

  const statusMap = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };
  const files = { staged: [], unstaged: [], untracked: [], conflicted: [], repoRoot };

  function parseNameStatus(output) {
    if (!output) return [];
    return output.split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const code = line.substring(0, tab).trim();
      let filePath = line.substring(tab + 1).trim();
      // Renamed: "old\tnew" — tomar el nuevo
      if (filePath.includes('\t')) filePath = filePath.split('\t').pop();
      const absolutePath = path.join(repoRoot, filePath);
      return { path: filePath, absolutePath, status: statusMap[code[0]] || code };
    });
  }

  // 1. Staged: archivos en el index (git add)
  const stagedResult = await runGit(['diff', '--cached', '--name-status'], cwd);
  if (!stagedResult.error && stagedResult.output) {
    files.staged = parseNameStatus(stagedResult.output);
  }

  // 2. Unstaged: cambios en el worktree (no staged)
  const unstagedResult = await runGit(['diff', '--name-status'], cwd);
  if (!unstagedResult.error && unstagedResult.output) {
    files.unstaged = parseNameStatus(unstagedResult.output);
  }

  // 3. Untracked: archivos nuevos no trackeados
  const untrackedResult = await runGit(['ls-files', '--others', '--exclude-standard'], cwd);
  if (!untrackedResult.error && untrackedResult.output) {
    files.untracked = untrackedResult.output.split('\n').filter(Boolean).map((filePath) => {
      const absolutePath = path.join(repoRoot, filePath);
      return { path: filePath, absolutePath, status: 'untracked' };
    });
  }

  // 4. Conflicted: archivos con merge conflicts (UU, AA, DD, AU, UA, DU, UD)
  const porcelainResult = await runGit(['status', '--porcelain'], cwd);
  if (!porcelainResult.error && porcelainResult.output) {
    const conflictCodes = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
    const conflictPaths = new Set();
    porcelainResult.output.split('\n').filter(Boolean).forEach((line) => {
      const xy = line.substring(0, 2);
      if (conflictCodes.has(xy)) {
        const filePath = line.substring(3).trim();
        conflictPaths.add(filePath);
        const absolutePath = path.join(repoRoot, filePath);
        files.conflicted.push({ path: filePath, absolutePath, status: 'conflict', conflictType: xy });
      }
    });
    // Quitar archivos en conflicto de staged/unstaged para no duplicar
    if (conflictPaths.size > 0) {
      files.staged = files.staged.filter((f) => !conflictPaths.has(f.path));
      files.unstaged = files.unstaged.filter((f) => !conflictPaths.has(f.path));
    }
  }

  return { files };
});

// git add (stage)
ipcMain.handle('git:add', async (event, cwd, filePaths) => {
  return runGit(['add', ...filePaths], cwd);
});

// git reset (unstage)
ipcMain.handle('git:unstage', async (event, cwd, filePaths) => {
  return runGit(['reset', 'HEAD', '--', ...filePaths], cwd);
});

// git commit
ipcMain.handle('git:commit', async (event, cwd, message) => {
  return runGit(['commit', '-m', message], cwd);
});

// git diff de un archivo
ipcMain.handle('git:diff', async (event, cwd, filePath, staged) => {
  const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath];
  return runGit(args, cwd);
});

// git show — obtener contenido de un archivo en HEAD o en el index
ipcMain.handle('git:show', async (event, cwd, filePath, ref) => {
  // ref puede ser 'HEAD' para el último commit, o ':' para el staging area
  const target = ref ? `${ref}:${filePath}` : `HEAD:${filePath}`;
  return runGit(['show', target], cwd);
});

// git log
ipcMain.handle('git:log', async (event, cwd, limit) => {
  const result = await runGit(
    ['log', `--max-count=${limit || 50}`, '--format=%H|%h|%an|%ar|%s'],
    cwd
  );
  if (result.error) return result;
  if (!result.output) return { commits: [] };

  const commits = result.output.split('\n').map((line) => {
    const [hash, shortHash, author, date, ...msgParts] = line.split('|');
    return { hash, shortHash, author, date, message: msgParts.join('|') };
  });

  return { commits };
});

// git discard changes (checkout file)
ipcMain.handle('git:discard', async (event, cwd, filePath) => {
  return runGit(['checkout', '--', filePath], cwd);
});

// git push
ipcMain.handle('git:push', async (event, cwd) => {
  return runGit(['push'], cwd);
});

// Listar todas las ramas del repo (locales + remotas).
// Devuelve { local: string[], remoteOnly: string[], current: string }
//
// Las ramas remotas se devuelven SIN el prefijo del remote (origin/),
// y solo se incluyen las que NO existen como branch local (para evitar
// duplicados en la UI). Esto permite al renderer mostrar una lista
// unificada donde las ramas locales aparecen primero y las remotas
// se distinguen con un tag "remote".
ipcMain.handle('git:listBranches', async (event, cwd) => {
  // Locales: git branch --format=...
  const localResult = await runGit(['branch', '--format=%(refname:short)'], cwd);
  const local = localResult.error ? [] : localResult.output.split('\n').filter(Boolean);

  // Remotas: git branch -r --format=...
  // Filtramos HEAD (origin/HEAD → origin/main, no es una rama real)
  // y quitamos el prefijo "origin/" para mostrar nombres limpios.
  const remoteResult = await runGit(['branch', '-r', '--format=%(refname:short)'], cwd);
  const remote = remoteResult.error ? [] : remoteResult.output
    .split('\n')
    .filter(Boolean)
    .filter(b => !b.includes('/HEAD'))
    .map(b => b.replace(/^[^/]+\//, ''));

  // Rama actual
  const currentResult = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const current = currentResult.error ? '' : currentResult.output;

  // Deduplicar: solo incluir remotas que no existen localmente
  const seen = new Set(local);
  const remoteOnly = remote.filter(b => !seen.has(b));

  return { local, remoteOnly, current };
});

// Cambiar de rama. Si la rama es remota y no existe localmente,
// git crea automáticamente una tracking branch local.
ipcMain.handle('git:checkout', async (event, cwd, branch) => {
  return runGit(['checkout', branch], cwd);
});

// git pull
ipcMain.handle('git:pull', async (event, cwd) => {
  return runGit(['pull'], cwd);
});

// ── Git Blame ────────────────────────────────────────────────

/**
 * Obtener la info de blame para una línea específica de un archivo.
 *
 * Usa git blame --porcelain -L line,line para obtener autor, fecha
 * y mensaje del commit que modificó esa línea por última vez.
 * Devuelve { author, date, hash, shortHash, summary } o error.
 */
ipcMain.handle('git:blame', async (event, cwd, filePath, line) => {
  const result = await runGit(
    ['blame', '--porcelain', `-L${line},${line}`, '--', filePath],
    cwd
  );
  if (result.error) return { error: result.error };
  if (!result.output) return { error: 'No blame data' };

  const lines = result.output.split('\n');
  const hash = lines[0]?.split(' ')[0] || '';

  // Archivo no commiteado (todo ceros)
  if (/^0+$/.test(hash)) {
    return { author: 'Not Committed Yet', date: '', hash: '', shortHash: '', summary: 'Uncommitted change' };
  }

  let author = '', authorTime = '', summary = '';
  for (const l of lines) {
    if (l.startsWith('author ')) author = l.substring(7);
    else if (l.startsWith('author-time ')) authorTime = l.substring(12);
    else if (l.startsWith('summary ')) summary = l.substring(8);
  }

  // Convertir timestamp a fecha relativa
  const ts = parseInt(authorTime, 10);
  let date = '';
  if (ts) {
    const diff = Math.floor((Date.now() / 1000) - ts);
    if (diff < 60) date = 'just now';
    else if (diff < 3600) date = `${Math.floor(diff / 60)} min ago`;
    else if (diff < 86400) date = `${Math.floor(diff / 3600)} hours ago`;
    else if (diff < 2592000) date = `${Math.floor(diff / 86400)} days ago`;
    else if (diff < 31536000) date = `${Math.floor(diff / 2592000)} months ago`;
    else date = `${Math.floor(diff / 31536000)} years ago`;
  }

  return { author, date, hash, shortHash: hash.substring(0, 7), summary };
});

// ── Git Merge Conflict Resolution ────────────────────────────

/**
 * Obtener el contenido de un archivo en conflicto para un lado específico.
 *
 * Git almacena tres versiones durante un merge en el index:
 *  - Stage 1 (base): versión ancestro común
 *  - Stage 2 (ours): nuestra versión (la rama actual)
 *  - Stage 3 (theirs): la versión entrante (la rama que se mergea)
 *
 * @param {string} side - 'base' (stage 1), 'ours' (stage 2), 'theirs' (stage 3)
 */
ipcMain.handle('git:conflictContent', async (event, cwd, filePath, side) => {
  const stageMap = { base: '1', ours: '2', theirs: '3' };
  const stage = stageMap[side];
  if (!stage) return { error: `Invalid side: ${side}` };
  return runGit(['show', `:${stage}:${filePath}`], cwd);
});

/**
 * Escribir contenido resuelto y marcar el archivo como resolvido (git add).
 *
 * El renderer envía el contenido final tras la resolución manual
 * o automática (Accept Ours / Accept Theirs / Accept Both).
 * Escribimos el archivo al disco y luego lo stageamos.
 */
ipcMain.handle('git:conflictResolve', async (event, cwd, filePath, content) => {
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], cwd);
  const root = rootResult.error ? cwd : rootResult.output;
  const absPath = path.join(root, filePath);
  try {
    fs.writeFileSync(absPath, content, 'utf-8');
  } catch (err) {
    return { error: `Failed to write file: ${err.message}` };
  }
  return runGit(['add', filePath], cwd);
});

// ── Git Stash ────────────────────────────────────────────────

/**
 * Listar todas las entradas del stash.
 * Devuelve un array de { ref, message, date }.
 */
ipcMain.handle('git:stashList', async (event, cwd) => {
  const result = await runGit(['stash', 'list', '--format=%gd|%gs|%ar'], cwd);
  if (result.error) return result;
  if (!result.output) return { stashes: [] };
  const stashes = result.output.split('\n').filter(Boolean).map((line) => {
    const [ref, message, date] = line.split('|');
    return { ref, message: message || '(no message)', date: date || '' };
  });
  return { stashes };
});

/**
 * Guardar cambios en el stash con un mensaje opcional.
 * -u incluye archivos untracked para no perderlos.
 */
ipcMain.handle('git:stashSave', async (event, cwd, message, includeUntracked) => {
  const args = ['stash', 'push'];
  if (includeUntracked) args.push('-u');
  if (message) args.push('-m', message);
  return runGit(args, cwd);
});

// Aplicar un stash sin eliminarlo de la lista
ipcMain.handle('git:stashApply', async (event, cwd, ref) => {
  return runGit(['stash', 'apply', ref], cwd);
});

// Aplicar un stash y eliminarlo de la lista
ipcMain.handle('git:stashPop', async (event, cwd, ref) => {
  return runGit(['stash', 'pop', ref], cwd);
});

// Eliminar un stash de la lista
ipcMain.handle('git:stashDrop', async (event, cwd, ref) => {
  return runGit(['stash', 'drop', ref], cwd);
});

// Ver el diff de un stash (para preview)
ipcMain.handle('git:stashShow', async (event, cwd, ref) => {
  return runGit(['stash', 'show', '-p', ref], cwd);
});

// git graph log — devuelve commits con info de padres, ramas y tags
ipcMain.handle('git:graphLog', async (event, cwd, limit) => {
  const SEP = '\x01'; // usar separador que no aparece en mensajes
  const result = await runGit(
    [
      'log', '--all', `--max-count=${limit || 150}`,
      `--format=%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ar${SEP}%s${SEP}%D`,
    ],
    cwd,
  );
  if (result.error) return result;
  if (!result.output) return { commits: [] };

  const commits = result.output.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(SEP);
    const [hash, shortHash, parents, author, date, message, refsPart] = parts;
    return {
      hash,
      shortHash,
      parents: parents ? parents.split(' ') : [],
      author,
      date,
      message: message || '',
      refs: refsPart ? refsPart.split(', ').map((r) => r.trim()).filter(Boolean) : [],
    };
  });

  return { commits };
});

/**
 * Obtiene los archivos modificados en un commit específico con su diff.
 * Usa git show --stat para la lista de archivos y git show para el diff completo.
 *
 * @param {string} cwd - Directorio del repositorio
 * @param {string} hash - Hash del commit
 * @returns {{ files: Array<{file, status, additions, deletions}>, diff: string, error?: string }}
 */
ipcMain.handle('git:commitDetail', async (event, cwd, hash) => {
  // Lista de archivos cambiados con stats
  const filesResult = await runGit(
    ['show', hash, '--name-status', '--format='],
    cwd
  );
  // Diff completo
  const diffResult = await runGit(
    ['show', hash, '--format=', '--patch'],
    cwd
  );

  if (filesResult.error) return { files: [], diff: '', error: filesResult.error };

  const statusMap = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };
  const files = (filesResult.output || '').split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const statusCode = parts[0].charAt(0);
    const file = parts.length > 2 ? `${parts[1]} → ${parts[2]}` : (parts[1] || '');
    return { file, status: statusMap[statusCode] || statusCode, statusCode };
  });

  return { files, diff: diffResult.output || '' };
});

// ────────────────────────────────────────────
// 7. IPC HANDLERS — LSP (Language Server Protocol)
//    Autocompletado, diagnósticos, go-to-definition
// ────────────────────────────────────────────
ipcMain.handle('lsp:start', async (event, workspaceFolder) => {
  if (lspManager) lspManager.stop();
  lspManager = new LspManager(mainWindow);
  return lspManager.start(workspaceFolder);
});

ipcMain.handle('lsp:stop', async () => {
  if (lspManager) {
    lspManager.stop();
    lspManager = null;
  }
});

ipcMain.handle('lsp:request', async (event, method, params) => {
  if (!lspManager || lspManager.state !== 'ready') {
    return null;
  }
  try {
    return await lspManager.sendRequest(method, params);
  } catch (err) {
    console.error('[LSP] Request error:', method, err.message);
    return null;
  }
});

ipcMain.on('lsp:notify', (event, method, params) => {
  if (lspManager && lspManager.state === 'ready') {
    lspManager.sendNotification(method, params);
  }
});

// ────────────────────────────────────────────────────
// 7a. IPC HANDLERS — TS LSP (TypeScript / JavaScript / React)
// ────────────────────────────────────────────────────
//
// Segundo servidor LSP para archivos TS/JS/JSX/TSX.
// Usa typescript-language-server con el TypeScript bundled.
// Canal IPC separado (tsLsp:*) para no interferir con PHP.

ipcMain.handle('tsLsp:start', async (event, workspaceFolder) => {
  if (tsLspManager) tsLspManager.stop();
  tsLspManager = new LspManager(mainWindow, 'tsLsp');
  return tsLspManager.startTs(workspaceFolder);
});

ipcMain.handle('tsLsp:stop', async () => {
  if (tsLspManager) {
    tsLspManager.stop();
    tsLspManager = null;
  }
});

ipcMain.handle('tsLsp:request', async (event, method, params) => {
  if (!tsLspManager || tsLspManager.state !== 'ready') return null;
  try {
    return await tsLspManager.sendRequest(method, params);
  } catch (err) {
    console.error('[tsLsp] Request error:', method, err.message);
    return null;
  }
});

ipcMain.on('tsLsp:notify', (event, method, params) => {
  if (tsLspManager && tsLspManager.state === 'ready') {
    tsLspManager.sendNotification(method, params);
  }
});

// ────────────────────────────────────────────────────
// 7b. IPC HANDLERS — XDEBUG (DBGp Debugger)
// ────────────────────────────────────────────────────
//
// Servidor TCP para debugging PHP via Xdebug. El manager escucha
// conexiones entrantes, gestiona breakpoints, controla la ejecución
// (run/step/stop), e inspecciona variables y call stack.

ipcMain.handle('xdebug:startListening', async (event, port, pathMappings) => {
  if (!xdebugManager) xdebugManager = new XdebugManager(mainWindow);
  return xdebugManager.startListening(port, pathMappings);
});

ipcMain.handle('xdebug:stopListening', async () => {
  if (!xdebugManager) return { success: true };
  return xdebugManager.stopListening();
});

ipcMain.handle('xdebug:getState', async () => {
  return xdebugManager ? xdebugManager.state : 'idle';
});

// Sincronizar breakpoints al main process (para auto-setup al conectar)
ipcMain.handle('xdebug:syncBreakpoints', async (event, breakpoints) => {
  if (!xdebugManager) xdebugManager = new XdebugManager(mainWindow);
  xdebugManager.syncBreakpoints(breakpoints);
  return { success: true };
});

// Breakpoints
ipcMain.handle('xdebug:setBreakpoint', async (event, filePath, line) => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.setBreakpoint(filePath, line);
});

ipcMain.handle('xdebug:removeBreakpoint', async (event, bpId) => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.removeBreakpoint(bpId);
});

// Execution control
ipcMain.handle('xdebug:run', async () => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.run();
});

ipcMain.handle('xdebug:stepOver', async () => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.stepOver();
});

ipcMain.handle('xdebug:stepInto', async () => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.stepInto();
});

ipcMain.handle('xdebug:stepOut', async () => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.stepOut();
});

ipcMain.handle('xdebug:stop', async () => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.stop();
});

// Inspection
ipcMain.handle('xdebug:getStack', async () => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.getStackFrames();
});

ipcMain.handle('xdebug:getContextNames', async (event, depth) => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.getContextNames(depth);
});

ipcMain.handle('xdebug:getContext', async (event, contextId, depth) => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.getContext(contextId, depth);
});

ipcMain.handle('xdebug:getProperty', async (event, fullname, depth, contextId) => {
  if (!xdebugManager || !xdebugManager.socket) return { error: 'No debug session' };
  return xdebugManager.getProperty(fullname, depth, contextId);
});

// ────────────────────────────────────────────
// 8. IPC HANDLER — THEME SYNC
//    Sincroniza el radio button del menú nativo con el tema activo
// ────────────────────────────────────────────
ipcMain.on('theme:sync', (event, themeName) => {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const temaMenu = menu.items.find((m) => m.label === 'Tema');
  if (!temaMenu || !temaMenu.submenu) return;

  // Actualizar radio buttons: desmarcar todos, marcar el activo
  temaMenu.submenu.items.forEach((item) => {
    if (item.type === 'radio') {
      // Built-in: comparar por themeName directo
      if (item.label === 'Mojave Dark') item.checked = themeName === 'dark';
      else if (item.label === 'Mojave Light') item.checked = themeName === 'light';
      // Custom: comparar por id del tema
      else {
        const custom = customThemeEntries.find(t => t.name === item.label);
        item.checked = custom ? custom.id === themeName : false;
      }
    }
  });
});

// ── Persistencia de tema en archivo ──
// Permite que nuevas ventanas (procesos separados) hereden el tema activo.
ipcMain.handle('theme:getConfig', () => getThemeConfig());

ipcMain.handle('theme:saveConfig', (event, config) => {
  saveThemeConfig(config);
});

// Sincronizar lista de temas custom desde el renderer.
// Se llama al crear o eliminar un tema. Reconstruye el menú
// para que los nuevos temas aparezcan en Tema > ...
ipcMain.on('theme:syncCustom', (event, themes) => {
  customThemeEntries = themes || [];
  createMenu();
});

// ────────────────────────────────────────────
// 9. IPC HANDLER — CPU USAGE
//    Calcula el porcentaje de uso de CPU del proceso Electron
// ────────────────────────────────────────────
let prevCpuUsage = null;
let prevCpuTime = null;

ipcMain.handle('system:cpuUsage', () => {
  const now = process.cpuUsage(prevCpuUsage);
  const nowTime = Date.now();

  let percent = 0;
  if (prevCpuTime) {
    const elapsedMs = (nowTime - prevCpuTime) * 1000; // a microsegundos
    const cpuUs = now.user + now.system;
    percent = Math.min(100, Math.round((cpuUs / elapsedMs) * 100));
  }

  prevCpuUsage = process.cpuUsage();
  prevCpuTime = nowTime;
  return percent;
});

// ────────────────────────────────────────────
// 10. IPC HANDLERS — SEARCH IN FILES
//     Busca texto o regex en todos los archivos del proyecto
// ────────────────────────────────────────────
ipcMain.handle('search:inFiles', async (event, rootDir, query, options = {}) => {
  const { isRegex = false, caseSensitive = false, maxResults = config.search.maxResults } = options;
  const results = [];
  const MAX_DEPTH = config.search.maxDepth;
  const MAX_FILE_SIZE = config.search.maxFileSize;

  let regex;
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    regex = isRegex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
  } catch (err) {
    return { error: `Invalid regex: ${err.message}`, results: [] };
  }

  async function searchDir(dir, depth) {
    if (depth > MAX_DEPTH || results.length >= maxResults) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!config.ignore.dirs.has(entry.name)) await searchDir(fullPath, depth + 1);
      } else {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        if (config.ignore.binaryExts.has(ext)) continue;

        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }

        let content;
        try {
          content = await fs.promises.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= maxResults) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            const relativePath = path.relative(rootDir, fullPath);
            results.push({
              file: relativePath,
              absolutePath: fullPath,
              line: i + 1,
              column: lines[i].search(new RegExp(isRegex ? query : escapeRegex(query), caseSensitive ? '' : 'i')) + 1,
              text: lines[i].trimStart(),
              lineText: lines[i],
            });
          }
        }
      }
    }
  }

  await searchDir(rootDir, 0);
  return { results, truncated: results.length >= maxResults };
});

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────────────────────
// 10b. IPC HANDLER — SEARCH SYMBOLS IN PROJECT
//      Extrae clases, funciones, métodos, etc. de todos los archivos
// ────────────────────────────────────────────
const symbolPatterns = {
  php: [
    { regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/,           kind: 'class' },
    { regex: /^\s*interface\s+(\w+)/,                                  kind: 'interface' },
    { regex: /^\s*trait\s+(\w+)/,                                      kind: 'class' },
    { regex: /^\s*(?:public|protected|private|static|\s)*function\s+(\w+)\s*\(/, kind: 'method' },
    { regex: /^\s*const\s+(\w+)\s*=/,                                  kind: 'const' },
  ],
  javascript: [
    { regex: /^\s*class\s+(\w+)/,                                      kind: 'class' },
    { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,        kind: 'function' },
    { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,    kind: 'function' },
    { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: 'function' },
    { regex: /^\s*const\s+([A-Z_][A-Z0-9_]*)\s*=/,                     kind: 'const' },
  ],
  typescript: [
    { regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,        kind: 'class' },
    { regex: /^\s*(?:export\s+)?interface\s+(\w+)/,                     kind: 'interface' },
    { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,        kind: 'function' },
    { regex: /^\s*(?:export\s+)?type\s+(\w+)/,                         kind: 'interface' },
  ],
  python: [
    { regex: /^\s*class\s+(\w+)/,                                      kind: 'class' },
    { regex: /^\s*(?:async\s+)?def\s+(\w+)/,                           kind: 'function' },
  ],
  java: [
    { regex: /^\s*(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { regex: /^\s*(?:public|private|protected)?\s*interface\s+(\w+)/,  kind: 'interface' },
    { regex: /^\s*(?:public|private|protected|static|\s)*\w+\s+(\w+)\s*\(/, kind: 'method' },
  ],
  go: [
    { regex: /^type\s+(\w+)\s+struct/,                                  kind: 'class' },
    { regex: /^type\s+(\w+)\s+interface/,                               kind: 'interface' },
    { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,            kind: 'function' },
  ],
  ruby: [
    { regex: /^\s*class\s+(\w+)/,                                      kind: 'class' },
    { regex: /^\s*module\s+(\w+)/,                                     kind: 'class' },
    { regex: /^\s*def\s+(\w+)/,                                        kind: 'method' },
  ],
  rust: [
    { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/,                          kind: 'class' },
    { regex: /^\s*(?:pub\s+)?trait\s+(\w+)/,                           kind: 'interface' },
    { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,                 kind: 'function' },
    { regex: /^\s*impl\s+(\w+)/,                                       kind: 'class' },
  ],
};

const langExtMap = config.langExtMap;

const falsePositives = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'try', 'do', 'throw']);

ipcMain.handle('search:symbols', async (event, rootDir) => {
  const symbols = [];
  const MAX_DEPTH = config.search.maxDepth;
  const MAX_FILES = config.search.maxFiles;
  const MAX_FILE_SIZE = config.search.maxSymbolFileSize;
  let fileCount = 0;

  async function walkDir(dir, depth) {
    if (depth > MAX_DEPTH || fileCount >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= MAX_FILES) break;
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!config.ignore.dirs.has(entry.name)) await walkDir(fullPath, depth + 1);
      } else {
        const ext = path.extname(entry.name).slice(1).toLowerCase();
        const lang = langExtMap[ext];
        if (!lang) continue; // Solo lenguajes con patrones definidos

        const patterns = symbolPatterns[lang];
        if (!patterns) continue;

        fileCount++;

        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }

        let content;
        try {
          content = await fs.promises.readFile(fullPath, 'utf-8');
        } catch { continue; }

        const relativePath = path.relative(rootDir, fullPath);
        const lines = content.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          for (const { regex, kind } of patterns) {
            const match = lines[i].match(regex);
            if (match) {
              const name = match[1];
              if (!name || falsePositives.has(name)) continue;
              symbols.push({
                name,
                kind,
                file: relativePath,
                absolutePath: fullPath,
                line: i + 1,
              });
              break;
            }
          }
        }
      }
    }
  }

  await walkDir(rootDir, 0);
  return { symbols };
});

// ────────────────────────────────────────────
// 11. IPC HANDLERS — PHP FORMAT ON SAVE & PHPUNIT
// ────────────────────────────────────────────

// Formatear un archivo PHP con Pint o CS Fixer
ipcMain.handle('php:format', async (event, filePath) => {
  if (!projectCapabilities.projectRoot) return { error: 'No project open' };

  const root = projectCapabilities.projectRoot;
  const { dockerContainer, dockerWorkdir } = projectCapabilities;

  if (projectCapabilities.hasPint) {
    if (dockerContainer && dockerWorkdir) {
      const relative = path.relative(root, filePath);
      const containerFile = path.posix.join(dockerWorkdir, relative);
      return runProjectCommand('vendor/bin/pint', [containerFile, '--no-interaction'], root);
    }
    // Local: usar php como runner en todas las plataformas (execFile no ejecuta .bat en Windows)
    const pintBin = path.join(root, 'vendor', 'bin', 'pint');
    return runCommand('php', [pintBin, filePath, '--no-interaction'], root);
  } else if (projectCapabilities.hasCsFixer) {
    if (dockerContainer && dockerWorkdir) {
      const relative = path.relative(root, filePath);
      const containerFile = path.posix.join(dockerWorkdir, relative);
      return runProjectCommand('vendor/bin/php-cs-fixer', ['fix', containerFile, '--no-interaction', '--quiet'], root);
    }
    const fixerBin = path.join(root, 'vendor', 'bin', 'php-cs-fixer');
    return runCommand('php', [fixerBin, 'fix', filePath, '--no-interaction', '--quiet'], root);
  }
  return { error: 'No PHP formatter found' };
});

// Toggle format on save
ipcMain.on('php:toggleFormatOnSave', (event, enabled) => {
  projectCapabilities.formatOnSave = enabled;
  createMenu(); // Rebuild para actualizar el checkbox del menú
});

// Ejecutar PHPUnit
ipcMain.handle('phpunit:run', async (event, args) => {
  if (!projectCapabilities.projectRoot) return { error: 'No project open' };
  const root = projectCapabilities.projectRoot;
  const { dockerContainer, dockerWorkdir } = projectCapabilities;
  if (dockerContainer && dockerWorkdir) {
    const cmdArgs = [...(args || []), '--colors=always'];
    return runProjectCommand('vendor/bin/phpunit', cmdArgs, root);
  }
  // Local: usar php como runner en todas las plataformas
  const phpunitBin = path.join(root, 'vendor', 'bin', 'phpunit');
  const cmdArgs = [...(args || []), '--colors=always'];
  return runCommand('php', [phpunitBin, ...cmdArgs], root);
});

// ────────────────────────────────────────────
// 12. IPC HANDLERS — DATABASE VIEWER
//     Usa db-helper.js para parsear .env y ejecutar queries via CLI
// ────────────────────────────────────────────

// Helper: obtener config de DB del proyecto actual, o devolver error
function getDbConfig() {
  if (!projectCapabilities.projectRoot) return { error: 'No project open' };
  const env = db.parseEnvFile(projectCapabilities.projectRoot);
  if (!env) return { error: '.env file not found' };
  return { config: db.getConnectionConfig(env) };
}

// Helper: obtener config de DB ajustada para ejecución local.
// Reemplaza host.docker.internal → 127.0.0.1 para que conecte al host.
function getLocalDbConfig() {
  const { error, config: cfg } = getDbConfig();
  if (error) return { error };
  if (cfg.host === 'host.docker.internal') {
    cfg.host = '127.0.0.1';
  }
  return { config: cfg };
}

// Helper: obtener todas las conexiones de DB, ajustadas para local.
function getAllLocalDbConfigs() {
  if (!projectCapabilities.projectRoot) return { error: 'No project open' };
  const env = db.parseEnvFile(projectCapabilities.projectRoot);
  if (!env) return { error: '.env file not found' };
  const connections = db.getAllConnectionConfigs(env);
  if (connections.length === 0) return { error: 'No database configured in .env' };
  for (const conn of connections) {
    if (conn.config.host === 'host.docker.internal') {
      conn.config.host = '127.0.0.1';
    }
  }
  return { connections };
}

// Helper: obtener config de una conexión específica por key
function getLocalDbConfigByKey(connKey) {
  const { error, connections } = getAllLocalDbConfigs();
  if (error) return { error };
  const found = connections.find((c) => c.key === connKey);
  if (!found) return { error: `Connection "${connKey}" not found` };
  return { config: found.config };
}

ipcMain.handle('db:getConfig', async () => {
  const { error, config: cfg } = getLocalDbConfig();
  return error ? { error } : cfg;
});

ipcMain.handle('db:getConnections', async () => {
  const { error, connections } = getAllLocalDbConfigs();
  if (error) return { error };
  return { connections: connections.map((c) => ({ key: c.key, label: c.label, config: c.config })) };
});

ipcMain.handle('db:getTables', async (event, connKey) => {
  const { error, config: cfg } = connKey ? getLocalDbConfigByKey(connKey) : getLocalDbConfig();
  if (error) return { error };

  let sql;
  if (cfg.connection === 'pgsql') {
    sql = "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
  } else {
    sql = 'SHOW TABLES';
  }

  const result = await db.execDb(cfg, sql);
  if (result.error) return result;
  return { tables: result.output.split('\n').filter(Boolean) };
});

ipcMain.handle('db:getColumns', async (event, tableName, connKey) => {
  const { error, config: cfg } = connKey ? getLocalDbConfigByKey(connKey) : getLocalDbConfig();
  if (error) return { error };

  const safeName = db.sanitizeIdentifier(tableName);
  let sql, parseRow;

  if (cfg.connection === 'pgsql') {
    sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '${db.sanitizeValue(tableName)}' ORDER BY ordinal_position`;
    parseRow = (line) => {
      const [name, type, nullable, defaultVal] = line.split('|');
      return { name, type, nullable: nullable === 'YES', default: defaultVal || null };
    };
  } else {
    sql = `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT FROM information_schema.columns WHERE TABLE_SCHEMA = '${db.sanitizeValue(cfg.database)}' AND TABLE_NAME = '${db.sanitizeValue(tableName)}' ORDER BY ORDINAL_POSITION`;
    parseRow = (line) => {
      const [name, type, nullable, key, defaultVal] = line.split('\t');
      return { name, type, nullable: nullable === 'YES', key: key || null, default: defaultVal || null };
    };
  }

  const result = await db.execDb(cfg, sql);
  if (result.error) return result;
  return { columns: result.output.split('\n').filter(Boolean).map(parseRow) };
});

ipcMain.handle('db:query', async (event, tableName, column, operator, value, limit, connKey) => {
  const { error, config: cfg } = connKey ? getLocalDbConfigByKey(connKey) : getLocalDbConfig();
  if (error) return { error };

  const safeTable = db.sanitizeIdentifier(tableName);
  const safeColumn = db.sanitizeIdentifier(column);
  const safeLimit = Math.min(parseInt(limit) || config.db.queryLimit.default, config.db.queryLimit.max);

  const allowedOps = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL'];
  const safeOp = allowedOps.includes(operator) ? operator : '=';

  let whereClause = '';
  if (safeColumn && safeOp) {
    if (safeOp === 'IS NULL' || safeOp === 'IS NOT NULL') {
      whereClause = `WHERE \`${safeColumn}\` ${safeOp}`;
    } else if (safeOp === 'LIKE' || safeOp === 'NOT LIKE') {
      whereClause = `WHERE \`${safeColumn}\` ${safeOp} '%${db.sanitizeValue(value)}%'`;
    } else {
      whereClause = `WHERE \`${safeColumn}\` ${safeOp} '${db.sanitizeValue(value)}'`;
    }
  }

  let sql = `SELECT * FROM \`${safeTable}\` ${whereClause} LIMIT ${safeLimit}`;
  // PostgreSQL usa comillas dobles para identificadores, no backticks
  if (cfg.connection === 'pgsql') sql = sql.replace(/`/g, '"');

  const result = await db.execDb(cfg, sql, { csv: true });
  if (result.error) return { error: result.error, sql };

  const lines = result.output.split('\n');
  if (lines.length < 1) return { columns: [], rows: [], sql };

  if (cfg.connection === 'pgsql') {
    return { columns: db.parseCsvLine(lines[0]), rows: lines.slice(1).filter(Boolean).map(db.parseCsvLine), sql };
  }
  return { columns: lines[0].split('\t'), rows: lines.slice(1).filter(Boolean).map((l) => l.split('\t')), sql };
});

ipcMain.handle('db:update', async (event, tableName, pkColumn, pkValue, column, newValue, connKey) => {
  const { error, config: cfg } = connKey ? getLocalDbConfigByKey(connKey) : getLocalDbConfig();
  if (error) return { error };

  const safeTable = db.sanitizeIdentifier(tableName);
  const safePkCol = db.sanitizeIdentifier(pkColumn);
  const safeCol = db.sanitizeIdentifier(column);
  const setClause = newValue === null
    ? `\`${safeCol}\` = NULL`
    : `\`${safeCol}\` = '${db.sanitizeValue(newValue)}'`;

  let sql = `UPDATE \`${safeTable}\` SET ${setClause} WHERE \`${safePkCol}\` = '${db.sanitizeValue(pkValue)}' LIMIT 1`;
  // PostgreSQL no acepta LIMIT en UPDATE ni backticks
  if (cfg.connection === 'pgsql') {
    sql = sql.replace(/`/g, '"').replace(/ LIMIT 1/, '');
  }

  const result = await db.execDb(cfg, sql);
  if (result.error) return { error: result.error, sql };
  return { success: true, sql };
});

// ─────────────────────────────────────────────────────
// 12b. IPC HANDLER — DB EXECUTE (SQL CONSOLE LIBRE)
// ─────────────────────────────────────────────────────

/**
 * Ejecuta SQL arbitrario ingresado por el usuario en la consola DB.
 *
 * Para SELECT devuelve columnas + filas (formato tabular).
 * Para UPDATE/INSERT/DELETE/CREATE/DROP devuelve un mensaje de éxito
 * y el número de filas afectadas si el motor lo reporta.
 *
 * La SQL viaja sin sanitizar — es el usuario quien la escribe, igual
 * que phpMyAdmin o TablePlus. No se expone al exterior.
 */
ipcMain.handle('db:execute', async (event, sql, connKey) => {
  const { error, config: cfg } = connKey ? getLocalDbConfigByKey(connKey) : getLocalDbConfig();
  if (error) return { error };

  const trimmed = sql.trim();
  if (!trimmed) return { error: 'Empty query' };

  // Detectar si es un SELECT (o SHOW/EXPLAIN/WITH) para devolver filas
  const isSelect = /^(SELECT|SHOW|EXPLAIN|WITH|DESCRIBE|DESC)\b/i.test(trimmed);

  const result = await db.execDb(cfg, trimmed, { csv: isSelect });
  if (result.error) return { error: result.error, sql: trimmed };

  if (!isSelect) {
    // DML/DDL — el output puede contener "N rows affected" en MySQL,
    // o estar vacío en psql (éxito silencioso). Normalizar.
    const affectedMatch = (result.output || '').match(/(\d+)\s+row/i);
    const affected = affectedMatch ? parseInt(affectedMatch[1]) : null;
    return { success: true, affected, sql: trimmed };
  }

  // SELECT — parsear CSV/TSV igual que db:query
  const lines = (result.output || '').split('\n');
  if (lines.length < 1 || !lines[0]) return { columns: [], rows: [], sql: trimmed };

  if (cfg.connection === 'pgsql') {
    return {
      columns: db.parseCsvLine(lines[0]),
      rows: lines.slice(1).filter(Boolean).map(db.parseCsvLine),
      sql: trimmed,
    };
  }
  return {
    columns: lines[0].split('\t'),
    rows: lines.slice(1).filter(Boolean).map((l) => l.split('\t')),
    sql: trimmed,
  };
});

// ─────────────────────────────────────────────────────
// 12c. IPC HANDLER — DB EXPORT
// ─────────────────────────────────────────────────────

/**
 * Exporta datos de la base de datos a archivo.
 *
 * Tipos soportados:
 *  • 'csv'  — exporta los resultados de una tabla (SELECT *) como CSV.
 *             Devuelve el contenido CSV como string para que el renderer
 *             lo guarde via dialog de archivo.
 *  • 'dump' — ejecuta mysqldump / pg_dump y devuelve
 *             el SQL completo del dump como string.
 *
 * @param {string} type      - 'csv' | 'dump'
 * @param {string} tableName - Nombre de la tabla (solo para 'csv')
 * @param {string} connKey   - Clave de conexión (opcional)
 */
ipcMain.handle('db:export', async (event, type, tableName, connKey) => {
  const { error, config: cfg } = connKey ? getLocalDbConfigByKey(connKey) : getLocalDbConfig();
  if (error) return { error };

  // ── CSV: SELECT * de la tabla y devolver como string ──────────
  if (type === 'csv') {
    const safeTable = db.sanitizeIdentifier(tableName);
    let sql = `SELECT * FROM \`${safeTable}\``;
    if (cfg.connection === 'pgsql') {
      sql = sql.replace(/`/g, '"');
    }
    const result = await db.execDb(cfg, sql, { csv: true });
    if (result.error) return { error: result.error };
    return { data: result.output, filename: `${safeTable}.csv` };
  }

  // ── DUMP: volcado completo de la base de datos ─────────────────
  if (type === 'dump') {
    if (cfg.connection === 'pgsql') {
      const pgEnv = { ...process.env, PGPASSWORD: cfg.password };
      const args = ['-h', cfg.host, '-p', cfg.port, '-U', cfg.username, cfg.database];
      const result = await new Promise((resolve) => {
        const { execFile } = require('child_process');
        execFile('pg_dump', args, { env: pgEnv, timeout: 120000, maxBuffer: 50 * 1024 * 1024, ...(process.platform === 'win32' ? { shell: true } : {}) }, (err, stdout, stderr) => {
          if (err && !stdout) return resolve({ error: stderr || err.message });
          resolve({ output: stdout });
        });
      });
      if (result.error) return { error: result.error };
      return { data: result.output, filename: `${cfg.database}_dump.sql` };
    }

    // MySQL (default)
    // --single-transaction para backup consistente sin bloquear tablas
    // --set-gtid-purged=OFF evita warnings de GTID en servidores con GTID habilitado
    // --no-tablespaces evita permisos innecesarios de PROCESS
    const args = [
      '-h', cfg.host, `-P${cfg.port}`, `-u${cfg.username}`,
      '--single-transaction', '--set-gtid-purged=OFF', '--no-tablespaces',
      cfg.database,
    ];
    if (cfg.password) args.push(`-p${cfg.password}`);
    const result = await new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('mysqldump', args, { timeout: 120000, maxBuffer: 50 * 1024 * 1024, ...(process.platform === 'win32' ? { shell: true } : {}) }, (err, stdout, stderr) => {
        // mysqldump manda warnings a stderr incluso cuando tiene éxito.
        // Solo tratar como error si no hay output Y hay error.
        if (err && !stdout) return resolve({ error: stderr || err.message });
        resolve({ output: stdout });
      });
    });
    if (result.error) return { error: result.error };
    return { data: result.output, filename: `${cfg.database}_dump.sql` };
  }

  return { error: `Unknown export type: ${type}` };
});

// ────────────────────────────────────────────
// 13. IPC HANDLER — PSR-4 NAMESPACE RESOLVER
// ────────────────────────────────────────────
/**
 * Busca un archivo por nombre dentro del proyecto, ignorando
 * vendor, node_modules, .git, etc. Devuelve el primer match.
 * Útil como fallback cuando PSR-4 no puede resolver el path.
 */
ipcMain.handle('fs:findFile', async (event, fileName) => {
  if (!projectCapabilities.projectRoot) return { path: null };
  const root = projectCapabilities.projectRoot;
  const ignoreDirs = config.ignore.dirs;

  function search(dir, depth) {
    if (depth > 10) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === fileName) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !ignoreDirs.has(entry.name) && !entry.name.startsWith('.')) {
        const found = search(path.join(dir, entry.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  const found = search(root, 0);
  return { path: found };
});

/**
 * Resuelve un FQCN (Fully Qualified Class Name) a un file path usando
 * los mappings PSR-4 del composer.json. Funciona con Laravel Modules,
 * namespaces custom, y cualquier estructura PSR-4.
 *
 * @param {string} fqcn - Ej: "Modules\\Reservas\\Http\\Controllers\\ReservasController"
 * @returns {{ path: string|null }}
 */
ipcMain.handle('php:resolvePsr4Route', async (event, fqcn) => {
  if (!projectCapabilities.projectRoot || !projectCapabilities.hasComposer) {
    return { path: null };
  }

  const root = projectCapabilities.projectRoot;
  let composerJson;
  try {
    composerJson = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf-8'));
  } catch {
    return { path: null };
  }

  const psr4 = {
    ...(composerJson.autoload?.['psr-4'] || {}),
    ...(composerJson['autoload-dev']?.['psr-4'] || {}),
  };

  // Normalizar FQCN: quitar leading backslash
  const normalized = fqcn.replace(/^\\/, '');

  // Buscar el mapping PSR-4 cuyo namespace prefix matchea el FQCN
  let bestMatch = null;
  let bestLen = 0;

  for (const [nsPrefix, dirPath] of Object.entries(psr4)) {
    const cleanNs = nsPrefix.replace(/\\$/, '');
    if ((normalized === cleanNs || normalized.startsWith(cleanNs + '\\')) && cleanNs.length > bestLen) {
      const dirs = Array.isArray(dirPath) ? dirPath : [dirPath];
      bestMatch = { nsPrefix: cleanNs, dir: dirs[0].replace(/\/$/, '') };
      bestLen = cleanNs.length;
    }
  }

  if (!bestMatch) return { path: null };

  // Convertir el resto del namespace a path
  const remainder = normalized.slice(bestMatch.nsPrefix.length).replace(/^\\/, '');
  const relativePath = remainder.replace(/\\/g, '/') + '.php';
  const fullPath = path.join(root, bestMatch.dir, relativePath);

  // Verificar que el archivo existe
  if (fs.existsSync(fullPath)) {
    return { path: fullPath };
  }

  return { path: null };
});

ipcMain.handle('php:resolvePsr4', async (event, filePath) => {
  if (!projectCapabilities.projectRoot || !projectCapabilities.hasComposer) {
    return { namespace: null };
  }

  const root = projectCapabilities.projectRoot;
  let composerJson;
  try {
    composerJson = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf-8'));
  } catch {
    return { namespace: null };
  }

  // Recopilar todos los mappings PSR-4 (autoload + autoload-dev)
  const psr4 = {
    ...(composerJson.autoload?.['psr-4'] || {}),
    ...(composerJson['autoload-dev']?.['psr-4'] || {}),
  };

  // Normalizar el path del archivo relativo al root
  const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
  const fileName = path.basename(filePath, '.php');

  // Buscar el mapping PSR-4 que matchea
  let bestMatch = null;
  let bestLen = 0;

  for (const [nsPrefix, dirPath] of Object.entries(psr4)) {
    // dirPath puede ser string o array
    const dirs = Array.isArray(dirPath) ? dirPath : [dirPath];
    for (const dir of dirs) {
      const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
      if (relativePath.startsWith(normalizedDir) && normalizedDir.length > bestLen) {
        bestMatch = { nsPrefix: nsPrefix.replace(/\\$/, ''), dir: normalizedDir };
        bestLen = normalizedDir.length;
      }
    }
  }

  if (!bestMatch) return { namespace: null, className: fileName };

  // Calcular el namespace: prefijo + subdirectorios
  const subPath = relativePath.slice(bestMatch.dir.length);
  const parts = subPath.split('/');
  parts.pop(); // quitar el nombre del archivo

  const namespace = parts.length > 0
    ? bestMatch.nsPrefix + '\\' + parts.join('\\')
    : bestMatch.nsPrefix;

  return { namespace, className: fileName };
});

// ────────────────────────────────────────────────────────────────
// 13b. IPC HANDLERS — PHP FUNCTIONS REFERENCE
// ────────────────────────────────────────────────────────────────

/**
 * Obtiene la lista de funciones internas de PHP con sus firmas
 * usando ReflectionFunction. Ejecuta un script PHP inline que
 * itera get_defined_functions()['internal'] y devuelve nombre,
 * parámetros y tipo de retorno de cada función.
 *
 * @returns {{ functions: Array<{name, params, returnType}>, error?: string }}
 */
ipcMain.handle('php:functions', async () => {
  const phpScript = `
    // ── Mapa de descripciones curadas para funciones comunes ──
    $desc = [
      'array_chunk' => 'Split an array into chunks of a given size',
      'array_column' => 'Return the values from a single column in an input array',
      'array_combine' => 'Create an array using one array for keys and another for values',
      'array_count_values' => 'Count all the values of an array',
      'array_diff' => 'Compute the difference of arrays',
      'array_diff_assoc' => 'Compute the difference of arrays with additional index check',
      'array_diff_key' => 'Compute the difference of arrays using keys for comparison',
      'array_fill' => 'Fill an array with values',
      'array_fill_keys' => 'Fill an array with values, specifying keys',
      'array_filter' => 'Filter elements of an array using a callback function',
      'array_flip' => 'Exchange all keys with their associated values',
      'array_intersect' => 'Compute the intersection of arrays',
      'array_intersect_key' => 'Compute the intersection of arrays using keys for comparison',
      'array_key_exists' => 'Check if the given key or index exists in the array',
      'array_key_first' => 'Get the first key of an array',
      'array_key_last' => 'Get the last key of an array',
      'array_keys' => 'Return all the keys or a subset of the keys of an array',
      'array_map' => 'Apply a callback to the elements of the given arrays',
      'array_merge' => 'Merge one or more arrays',
      'array_merge_recursive' => 'Merge one or more arrays recursively',
      'array_multisort' => 'Sort multiple or multi-dimensional arrays',
      'array_pad' => 'Pad array to the specified length with a value',
      'array_pop' => 'Pop the element off the end of array',
      'array_product' => 'Calculate the product of values in an array',
      'array_push' => 'Push one or more elements onto the end of array',
      'array_rand' => 'Pick one or more random keys out of an array',
      'array_reduce' => 'Reduce the array to a single value using a callback function',
      'array_replace' => 'Replace the values of the first array with values having same keys',
      'array_reverse' => 'Return an array with elements in reverse order',
      'array_search' => 'Search an array for a given value and return the corresponding key',
      'array_shift' => 'Shift an element off the beginning of array',
      'array_slice' => 'Extract a slice of the array',
      'array_splice' => 'Remove a portion and replace it with something else',
      'array_sum' => 'Calculate the sum of values in an array',
      'array_unique' => 'Remove duplicate values from an array',
      'array_unshift' => 'Prepend one or more elements to the beginning of an array',
      'array_values' => 'Return all the values of an array',
      'array_walk' => 'Apply a user function to every member of an array',
      'arsort' => 'Sort an array in descending order and maintain index association',
      'asort' => 'Sort an array in ascending order and maintain index association',
      'compact' => 'Create array containing variables and their values',
      'count' => 'Count all elements in an array or a Countable object',
      'current' => 'Return the current element in an array',
      'each' => 'Return the current key and value pair from an array',
      'end' => 'Set the internal pointer to the last element',
      'extract' => 'Import variables into the current scope from an array',
      'in_array' => 'Check if a value exists in an array',
      'key' => 'Fetch a key from an array',
      'krsort' => 'Sort an array by key in descending order',
      'ksort' => 'Sort an array by key in ascending order',
      'list' => 'Assign variables as if they were an array',
      'natcasesort' => 'Sort an array using case-insensitive natural order',
      'natsort' => 'Sort an array using natural order algorithm',
      'next' => 'Advance the internal pointer of an array',
      'prev' => 'Rewind the internal array pointer',
      'range' => 'Create an array containing a range of elements',
      'reset' => 'Set the internal pointer to the first element',
      'rsort' => 'Sort an array in descending order',
      'shuffle' => 'Shuffle an array randomly',
      'sizeof' => 'Alias of count — count elements in an array',
      'sort' => 'Sort an array in ascending order',
      'usort' => 'Sort an array by values using a user-defined comparison function',
      'uasort' => 'Sort an array with a user-defined comparison function (maintain keys)',
      'uksort' => 'Sort an array by keys using a user-defined comparison function',

      'strlen' => 'Get string length',
      'strpos' => 'Find the position of the first occurrence of a substring',
      'strrpos' => 'Find the position of the last occurrence of a substring',
      'stripos' => 'Find the position of first occurrence (case-insensitive)',
      'strripos' => 'Find the position of last occurrence (case-insensitive)',
      'substr' => 'Return part of a string',
      'substr_count' => 'Count the number of substring occurrences',
      'substr_replace' => 'Replace text within a portion of a string',
      'str_contains' => 'Check if a string contains a given substring',
      'str_starts_with' => 'Check if a string starts with a given substring',
      'str_ends_with' => 'Check if a string ends with a given substring',
      'str_replace' => 'Replace all occurrences of the search string with the replacement',
      'str_ireplace' => 'Case-insensitive version of str_replace',
      'str_repeat' => 'Repeat a string a given number of times',
      'str_pad' => 'Pad a string to a certain length with another string',
      'str_split' => 'Convert a string to an array',
      'str_word_count' => 'Return the number of words in a string',
      'str_getcsv' => 'Parse a CSV string into an array',
      'strtolower' => 'Make a string lowercase',
      'strtoupper' => 'Make a string uppercase',
      'lcfirst' => 'Make the first character lowercase',
      'ucfirst' => 'Make the first character uppercase',
      'ucwords' => 'Uppercase the first character of each word',
      'trim' => 'Strip whitespace from the beginning and end of a string',
      'ltrim' => 'Strip whitespace from the beginning of a string',
      'rtrim' => 'Strip whitespace from the end of a string',
      'nl2br' => 'Insert HTML line breaks before all newlines',
      'wordwrap' => 'Wrap a string to a given number of characters',
      'explode' => 'Split a string by a delimiter into an array',
      'implode' => 'Join array elements with a string',
      'join' => 'Alias of implode — join array elements with a string',
      'sprintf' => 'Return a formatted string',
      'printf' => 'Output a formatted string',
      'fprintf' => 'Write a formatted string to a stream',
      'sscanf' => 'Parse a string according to a format',
      'number_format' => 'Format a number with grouped thousands',
      'money_format' => 'Format a number as a currency string',
      'chunk_split' => 'Split a string into smaller chunks',
      'htmlspecialchars' => 'Convert special characters to HTML entities',
      'htmlentities' => 'Convert all applicable characters to HTML entities',
      'htmlspecialchars_decode' => 'Convert HTML entities back to special characters',
      'html_entity_decode' => 'Convert HTML entities back to characters',
      'strip_tags' => 'Strip HTML and PHP tags from a string',
      'addslashes' => 'Quote a string with slashes',
      'stripslashes' => 'Remove backslashes from a string',
      'addcslashes' => 'Quote string with slashes in a C style',
      'stripcslashes' => 'Un-quote string quoted with addcslashes',
      'md5' => 'Calculate the MD5 hash of a string',
      'sha1' => 'Calculate the SHA-1 hash of a string',
      'crc32' => 'Calculate the CRC32 polynomial of a string',
      'base64_encode' => 'Encode data with MIME base64',
      'base64_decode' => 'Decode data encoded with MIME base64',
      'urlencode' => 'URL-encode a string',
      'urldecode' => 'Decode a URL-encoded string',
      'rawurlencode' => 'URL-encode according to RFC 3986',
      'rawurldecode' => 'Decode a URL-encoded string (RFC 3986)',
      'http_build_query' => 'Generate URL-encoded query string',
      'parse_url' => 'Parse a URL and return its components',
      'parse_str' => 'Parse a query string into variables',
      'quoted_printable_encode' => 'Convert a string to quoted-printable encoding',
      'quoted_printable_decode' => 'Decode quoted-printable encoded string',
      'convert_uuencode' => 'Uuencode a string',
      'convert_uudecode' => 'Decode a uuencoded string',
      'hex2bin' => 'Decode a hexadecimally encoded binary string',
      'bin2hex' => 'Convert binary data into hexadecimal representation',
      'ord' => 'Convert the first byte of a string to ASCII value',
      'chr' => 'Generate a single-byte string from a number',
      'strcmp' => 'Binary-safe string comparison',
      'strncmp' => 'Binary-safe string comparison of the first n characters',
      'strcasecmp' => 'Binary-safe case-insensitive string comparison',
      'strncasecmp' => 'Case-insensitive string comparison of first n characters',
      'similar_text' => 'Calculate the similarity between two strings',
      'soundex' => 'Calculate the soundex key of a string',
      'metaphone' => 'Calculate the metaphone key of a string',
      'levenshtein' => 'Calculate Levenshtein distance between two strings',
      'str_rot13' => 'Perform ROT13 transform on a string',
      'crypt' => 'One-way string hashing',
      'password_hash' => 'Create a password hash',
      'password_verify' => 'Verify that a password matches a hash',
      'password_needs_rehash' => 'Check if hash needs to be rehashed',

      'preg_match' => 'Perform a regular expression match',
      'preg_match_all' => 'Perform a global regular expression match',
      'preg_replace' => 'Perform a regular expression search and replace',
      'preg_replace_callback' => 'Perform regex search and replace using a callback',
      'preg_split' => 'Split string by a regular expression',
      'preg_grep' => 'Return array entries that match the pattern',
      'preg_quote' => 'Quote regular expression characters',
      'preg_last_error' => 'Return the error code of the last PCRE regex execution',

      'file_get_contents' => 'Read entire file into a string',
      'file_put_contents' => 'Write data to a file',
      'file_exists' => 'Check whether a file or directory exists',
      'file' => 'Read entire file into an array (one line per element)',
      'fopen' => 'Open a file or URL',
      'fclose' => 'Close an open file pointer',
      'fread' => 'Read from an open file (binary-safe)',
      'fwrite' => 'Write to an open file (binary-safe)',
      'fgets' => 'Read a line from an open file',
      'fgetc' => 'Read a single character from an open file',
      'fgetcsv' => 'Read a line from a file and parse CSV fields',
      'fputcsv' => 'Format a line as CSV and write to file',
      'feof' => 'Test for end-of-file on a file pointer',
      'fseek' => 'Seek on a file pointer',
      'ftell' => 'Return the current position of the file read/write pointer',
      'fflush' => 'Flush the output to a file',
      'flock' => 'Portable advisory file locking',
      'ftruncate' => 'Truncate a file to a given length',
      'fstat' => 'Get information about a file using an open file pointer',
      'copy' => 'Copy a file',
      'rename' => 'Rename a file or directory',
      'unlink' => 'Delete a file',
      'mkdir' => 'Create a directory',
      'rmdir' => 'Remove a directory',
      'is_file' => 'Test whether the path is a regular file',
      'is_dir' => 'Test whether the path is a directory',
      'is_readable' => 'Test whether the file is readable',
      'is_writable' => 'Test whether the file is writable',
      'is_link' => 'Test whether the file is a symbolic link',
      'filetype' => 'Get file type (file, dir, link, etc.)',
      'filesize' => 'Get the size of the file',
      'filemtime' => 'Get the last modification time of the file',
      'fileatime' => 'Get the last access time of the file',
      'filectime' => 'Get the inode change time of the file',
      'fileperms' => 'Get file permissions',
      'fileowner' => 'Get file owner',
      'filegroup' => 'Get file group',
      'glob' => 'Find pathnames matching a pattern',
      'scandir' => 'List files and directories inside the specified path',
      'opendir' => 'Open a directory handle',
      'readdir' => 'Read entry from directory handle',
      'closedir' => 'Close a directory handle',
      'basename' => 'Return the trailing name component of a path',
      'dirname' => 'Return a parent directory path',
      'pathinfo' => 'Return information about a file path',
      'realpath' => 'Return the canonicalized absolute pathname',
      'tempnam' => 'Create a file with a unique file name',
      'tmpfile' => 'Create a temporary file',
      'chmod' => 'Change file mode (permissions)',
      'chown' => 'Change file owner',
      'chgrp' => 'Change file group',
      'symlink' => 'Create a symbolic link',
      'readlink' => 'Return the target of a symbolic link',
      'stat' => 'Give information about a file',
      'lstat' => 'Give information about a file or symbolic link',
      'touch' => 'Set access and modification time of file',

      'json_encode' => 'Return the JSON representation of a value',
      'json_decode' => 'Decode a JSON string into a PHP value',
      'json_last_error' => 'Return the last error occurred during JSON encoding/decoding',
      'json_last_error_msg' => 'Return the error string of the last json_encode/decode call',

      'date' => 'Format a local date/time',
      'time' => 'Return current Unix timestamp',
      'mktime' => 'Get Unix timestamp for a date',
      'strtotime' => 'Parse an English date/time string to Unix timestamp',
      'strftime' => 'Format a local time/date according to locale settings',
      'gmdate' => 'Format a GMT/UTC date/time',
      'getdate' => 'Get date/time information',
      'localtime' => 'Get the local time',
      'microtime' => 'Return current Unix timestamp with microseconds',
      'gettimeofday' => 'Get current time of day',
      'date_create' => 'Create a new DateTime object',
      'date_format' => 'Return date formatted according to given format',
      'date_diff' => 'Return the difference between two DateTime objects',
      'date_add' => 'Add an amount of days, months, years, etc. to a DateTime',
      'date_sub' => 'Subtract days, months, years, etc. from a DateTime',
      'date_modify' => 'Alter the timestamp of a DateTime object',
      'checkdate' => 'Validate a Gregorian date',
      'date_default_timezone_set' => 'Set the default timezone',
      'date_default_timezone_get' => 'Get the default timezone',

      'abs' => 'Absolute value',
      'ceil' => 'Round fractions up',
      'floor' => 'Round fractions down',
      'round' => 'Round a float to a specified precision',
      'max' => 'Find highest value',
      'min' => 'Find lowest value',
      'pow' => 'Exponential expression (base raised to power)',
      'sqrt' => 'Square root',
      'log' => 'Natural logarithm',
      'log2' => 'Base-2 logarithm',
      'log10' => 'Base-10 logarithm',
      'rand' => 'Generate a random integer',
      'mt_rand' => 'Generate a random value via Mersenne Twister',
      'random_int' => 'Generate a cryptographically secure random integer',
      'random_bytes' => 'Generate cryptographically secure random bytes',
      'intdiv' => 'Integer division',
      'fmod' => 'Floating point modulo (remainder of division)',
      'intval' => 'Get the integer value of a variable',
      'floatval' => 'Get the float value of a variable',
      'doubleval' => 'Alias of floatval',
      'pi' => 'Get the value of pi',
      'base_convert' => 'Convert a number between arbitrary bases',
      'bindec' => 'Binary to decimal',
      'octdec' => 'Octal to decimal',
      'hexdec' => 'Hexadecimal to decimal',
      'decoct' => 'Decimal to octal',
      'dechex' => 'Decimal to hexadecimal',
      'decbin' => 'Decimal to binary',

      'var_dump' => 'Dump information about a variable',
      'var_export' => 'Output or return a parsable string representation of a variable',
      'print_r' => 'Print human-readable information about a variable',
      'debug_zval_refs' => 'Dump a string representation of an internal zval structure',
      'debug_backtrace' => 'Generate a backtrace',
      'debug_print_backtrace' => 'Print a backtrace',

      'isset' => 'Determine if a variable is declared and not null',
      'unset' => 'Unset a given variable',
      'empty' => 'Determine whether a variable is empty',
      'is_null' => 'Check whether a variable is null',
      'is_int' => 'Check whether a variable is an integer',
      'is_integer' => 'Alias of is_int',
      'is_long' => 'Alias of is_int',
      'is_float' => 'Check whether a variable is a float',
      'is_double' => 'Alias of is_float',
      'is_string' => 'Check whether a variable is a string',
      'is_bool' => 'Check whether a variable is a boolean',
      'is_array' => 'Check whether a variable is an array',
      'is_object' => 'Check whether a variable is an object',
      'is_numeric' => 'Check whether a variable is numeric or a numeric string',
      'is_callable' => 'Verify that a value can be called as a function',
      'is_resource' => 'Check whether a variable is a resource',
      'gettype' => 'Get the type of a variable',
      'settype' => 'Set the type of a variable',
      'boolval' => 'Get the boolean value of a variable',
      'strval' => 'Get the string value of a variable',

      'class_exists' => 'Check if a class has been defined',
      'interface_exists' => 'Check if an interface has been defined',
      'trait_exists' => 'Check if a trait exists',
      'method_exists' => 'Check if a method exists in a class',
      'property_exists' => 'Check if a property exists in a class or object',
      'function_exists' => 'Return true if the given function has been defined',
      'get_class' => 'Return the name of the class of an object',
      'get_parent_class' => 'Return the name of the parent class',
      'get_class_methods' => 'Get the class methods names',
      'get_object_vars' => 'Get the accessible properties of the given object',
      'get_defined_vars' => 'Return an array of all defined variables',
      'get_defined_functions' => 'Return an array of all defined functions',
      'get_defined_constants' => 'Return an associative array with the names of all constants',

      'echo' => 'Output one or more strings',
      'print' => 'Output a string',
      'die' => 'Output a message and terminate the script',
      'exit' => 'Output a message and terminate the script',
      'sleep' => 'Delay execution for a given number of seconds',
      'usleep' => 'Delay execution in microseconds',
      'time_sleep_until' => 'Make the script sleep until the specified time',
      'header' => 'Send a raw HTTP header',
      'headers_sent' => 'Check if headers have already been sent',
      'http_response_code' => 'Get or set the HTTP response status code',
      'setcookie' => 'Send a cookie',
      'session_start' => 'Start a new session or resume an existing one',
      'session_destroy' => 'Destroy all data registered to a session',
      'session_id' => 'Get or set the current session id',
      'session_regenerate_id' => 'Update the current session id with a newly generated one',

      'mail' => 'Send an email message',
      'exec' => 'Execute an external program',
      'shell_exec' => 'Execute command via shell and return the complete output',
      'system' => 'Execute an external program and display the output',
      'passthru' => 'Execute an external program and display raw output',
      'escapeshellarg' => 'Escape a string to be used as a shell argument',
      'escapeshellcmd' => 'Escape shell metacharacters',

      'phpinfo' => 'Output information about PHP configuration',
      'phpversion' => 'Get the current PHP version',
      'php_uname' => 'Return information about the operating system',
      'php_sapi_name' => 'Return the type of interface between PHP and the server',
      'ini_get' => 'Get the value of a configuration option',
      'ini_set' => 'Set the value of a configuration option',
      'getenv' => 'Get the value of an environment variable',
      'putenv' => 'Set the value of an environment variable',
      'memory_get_usage' => 'Return the amount of memory allocated to PHP',
      'memory_get_peak_usage' => 'Return the peak memory allocated to PHP',
      'gc_collect_cycles' => 'Force collection of any existing garbage cycles',
      'error_reporting' => 'Set which PHP errors are reported',
      'set_error_handler' => 'Set a user-defined error handler function',
      'set_exception_handler' => 'Set a user-defined exception handler function',
      'trigger_error' => 'Generate a user-level error/warning/notice message',
      'register_shutdown_function' => 'Register a function for execution on shutdown',

      'array_is_list' => 'Check whether the array is a list (sequential integer keys from 0)',
      'array_any' => 'Check if at least one element satisfies the callback',
      'array_all' => 'Check if all elements satisfy the callback',
      'enum_exists' => 'Check if an enum has been defined',
    ];

    // ── Descripciones por prefijo/familia de funciones ──
    $prefixDesc = [
      'array_' => 'Array operation',
      'str_' => 'String operation',
      'str' => 'String operation',
      'mb_' => 'Multibyte string operation',
      'preg_' => 'Regular expression operation',
      'file' => 'Filesystem operation',
      'f' => 'File I/O operation',
      'dir' => 'Directory operation',
      'json_' => 'JSON operation',
      'date' => 'Date/time operation',
      'time' => 'Time operation',
      'curl_' => 'cURL HTTP client operation',
      'socket_' => 'Socket operation',
      'stream_' => 'Stream operation',
      'openssl_' => 'OpenSSL cryptography operation',
      'hash' => 'Hashing operation',
      'ctype_' => 'Character type checking',
      'iconv_' => 'Character encoding conversion',
      'intl_' => 'Internationalization operation',
      'xml_' => 'XML parser operation',
      'simplexml_' => 'SimpleXML operation',
      'dom_' => 'DOM XML operation',
      'libxml_' => 'libXML operation',
      'pdo_' => 'PDO database operation',
      'mysqli_' => 'MySQLi database operation',
      'pg_' => 'PostgreSQL database operation',
      'sqlite_' => 'SQLite database operation',
      'image' => 'Image/GD operation',
      'gd_' => 'GD image operation',
      'exif_' => 'EXIF image metadata operation',
      'zip_' => 'ZIP archive operation',
      'zlib_' => 'Zlib compression operation',
      'gz' => 'Gzip compression operation',
      'bz' => 'Bzip2 compression operation',
      'pcntl_' => 'Process control operation',
      'posix_' => 'POSIX operation',
      'sem_' => 'Semaphore operation',
      'shm_' => 'Shared memory operation',
      'msg_' => 'Message queue operation',
      'spl_' => 'SPL data structure operation',
      'ftp_' => 'FTP operation',
      'imap_' => 'IMAP email operation',
      'ldap_' => 'LDAP directory operation',
      'sodium_' => 'Sodium cryptography operation',
      'apcu_' => 'APCu cache operation',
      'opcache_' => 'OPCache operation',
      'readline_' => 'Readline operation',
      'yaml_' => 'YAML parsing operation',
      'filter_' => 'Data filtering/validation',
      'is_' => 'Type checking',
      'ob_' => 'Output buffering operation',
      'session_' => 'Session management',
      'token_' => 'PHP tokenizer operation',
      'class_' => 'Class introspection',
      'get_' => 'Get information',
      'set_' => 'Set configuration',
    ];

    // ── Descripciones por extensión ──
    $extDesc = [
      'Core' => 'PHP core function',
      'standard' => 'PHP standard library function',
      'date' => 'Date/time function',
      'pcre' => 'Regular expression function (PCRE)',
      'json' => 'JSON encoding/decoding function',
      'mbstring' => 'Multibyte string function',
      'openssl' => 'OpenSSL cryptography function',
      'curl' => 'cURL HTTP client function',
      'PDO' => 'PDO database abstraction function',
      'mysqli' => 'MySQL Improved Extension function',
      'pgsql' => 'PostgreSQL function',
      'sqlite3' => 'SQLite3 function',
      'gd' => 'Image processing function (GD)',
      'xml' => 'XML parser function',
      'SimpleXML' => 'SimpleXML function',
      'dom' => 'DOM XML function',
      'libxml' => 'libXML function',
      'zip' => 'ZIP archive function',
      'zlib' => 'Compression function (zlib)',
      'intl' => 'Internationalization function (ICU)',
      'iconv' => 'Character encoding function',
      'Reflection' => 'Reflection API function',
      'SPL' => 'Standard PHP Library function',
      'tokenizer' => 'PHP tokenizer function',
      'filter' => 'Data filtering function',
      'hash' => 'Hash/HMAC function',
      'session' => 'Session management function',
      'ctype' => 'Character type checking function',
      'sodium' => 'Sodium cryptography function',
      'fileinfo' => 'File information function',
      'ftp' => 'FTP function',
      'imap' => 'IMAP mail function',
      'ldap' => 'LDAP function',
      'Phar' => 'PHP Archive function',
      'posix' => 'POSIX function',
      'readline' => 'Readline function',
      'shmop' => 'Shared memory function',
      'sockets' => 'Socket function',
      'exif' => 'EXIF metadata function',
      'calendar' => 'Calendar conversion function',
      'bcmath' => 'Arbitrary precision math function',
      'gmp' => 'GNU Multiple Precision math function',
    ];

    function getDescription($name, $ext, $desc, $prefixDesc, $extDesc) {
      // 1. Curada
      if (isset($desc[$name])) return $desc[$name];
      // 2. Por prefijo
      foreach ($prefixDesc as $prefix => $d) {
        if (str_starts_with($name, $prefix)) return $d;
      }
      // 3. Por extensión
      if (isset($extDesc[$ext])) return $extDesc[$ext];
      // 4. Fallback
      return $ext ? ucfirst($ext) . ' function' : 'PHP function';
    }

    $funcs = get_defined_functions()['internal'];
    sort($funcs);
    $result = [];
    foreach ($funcs as $f) {
      try {
        $rf = new ReflectionFunction($f);
        $params = [];
        foreach ($rf->getParameters() as $p) {
          $s = '';
          if ($p->hasType()) $s .= $p->getType() . ' ';
          if ($p->isPassedByReference()) $s .= '&';
          $s .= '$' . $p->getName();
          if ($p->isOptional() && !$p->isVariadic()) $s .= ' = …';
          if ($p->isVariadic()) $s = '...' . $s;
          $params[] = $s;
        }
        $ret = $rf->hasReturnType() ? (string)$rf->getReturnType() : '';
        $ext = $rf->getExtensionName() ?: 'Core';
        $result[] = [
          'name' => $f,
          'params' => implode(', ', $params),
          'returnType' => $ret,
          'desc' => getDescription($f, $ext, $desc, $prefixDesc, $extDesc),
        ];
      } catch (Exception $e) {
        $result[] = ['name' => $f, 'params' => '', 'returnType' => '', 'desc' => ''];
      }
    }
    echo json_encode($result);
  `;

  try {
    const res = await runProjectCommand('php', ['-r', phpScript],
      projectCapabilities.projectRoot || process.cwd());
    if (res.error && !res.output) return { functions: [], error: res.error };
    const functions = JSON.parse(res.output);
    return { functions };
  } catch (e) {
    return { functions: [], error: e.message };
  }
});

/**
 * Obtiene documentación detallada de una función PHP específica
 * usando ReflectionFunction. Devuelve parámetros completos con tipos,
 * valores default, extensión, deprecación, etc.
 *
 * @param {string} fnName - Nombre de la función PHP
 * @returns {{ detail: Object, error?: string }}
 */
ipcMain.handle('php:functionDetail', async (event, fnName) => {
  if (!fnName) return { detail: null, error: 'No function name' };

  const phpScript = `
    try {
      $rf = new ReflectionFunction('${fnName.replace(/'/g, "\\'")}');
      $params = [];
      foreach ($rf->getParameters() as $p) {
        $param = [
          'name' => $p->getName(),
          'type' => $p->hasType() ? (string)$p->getType() : null,
          'optional' => $p->isOptional(),
          'variadic' => $p->isVariadic(),
          'byRef' => $p->isPassedByReference(),
          'default' => null,
        ];
        if ($p->isDefaultValueAvailable()) {
          $dv = $p->getDefaultValue();
          $param['default'] = is_string($dv) ? '"' . $dv . '"' : var_export($dv, true);
        }
        $params[] = $param;
      }

      // ── Generar ejemplos de uso ──
      // Función auxiliar: valor de ejemplo según el tipo del parámetro
      function sampleValue($type, $name) {
        $t = strtolower((string)$type);
        // Inferir por nombre del parámetro
        $n = strtolower($name);
        if (str_contains($n, 'separator') || str_contains($n, 'delimiter') || $n === 'glue') return "', '";
        if (str_contains($n, 'pattern') || str_contains($n, 'regex')) return "'/[0-9]+/'";
        if (str_contains($n, 'replace') || str_contains($n, 'replacement')) return "'new'";
        if (str_contains($n, 'filename') || str_contains($n, 'file') || str_contains($n, 'path') || str_contains($n, 'directory')) return "'/path/to/file.txt'";
        if (str_contains($n, 'url')) return "'https://example.com'";
        if (str_contains($n, 'format')) return "'Y-m-d H:i:s'";
        if (str_contains($n, 'encoding') || str_contains($n, 'charset')) return "'UTF-8'";
        if (str_contains($n, 'offset') || str_contains($n, 'start') || str_contains($n, 'position')) return '0';
        if (str_contains($n, 'length') || str_contains($n, 'limit') || str_contains($n, 'count') || str_contains($n, 'size')) return '10';
        if (str_contains($n, 'callback') || str_contains($n, 'func')) return "function(\\$v) { return \\$v; }";
        if (str_contains($n, 'key')) return "'key'";
        if (str_contains($n, 'value') || str_contains($n, 'val')) return "'value'";
        // Inferir por tipo
        if (str_contains($t, 'string')) return "'hello world'";
        if (str_contains($t, 'int') || str_contains($t, 'float') || str_contains($t, 'number')) return '42';
        if (str_contains($t, 'bool')) return 'true';
        if (str_contains($t, 'array')) return "['a', 'b', 'c']";
        if (str_contains($t, 'callable')) return "function(\\$v) { return \\$v; }";
        if ($t === 'null' || $t === '') return "'example'";
        return "'example'";
      }

      $examples = [];
      $name = $rf->getName();
      $allParams = $rf->getParameters();
      $reqCount = $rf->getNumberOfRequiredParameters();

      // Caso 1: Solo parámetros requeridos
      $reqArgs = [];
      for ($i = 0; $i < $reqCount; $i++) {
        $p = $allParams[$i];
        if ($p->isVariadic()) {
          $reqArgs[] = sampleValue($p->hasType() ? (string)$p->getType() : '', $p->getName());
        } else {
          $reqArgs[] = sampleValue($p->hasType() ? (string)$p->getType() : '', $p->getName());
        }
      }
      $reqCall = "\\$result = {$name}(" . implode(', ', $reqArgs) . ");";
      if ($reqCount > 0 || count($allParams) === 0) {
        $examples[] = [
          'title' => 'Basic usage' . ($reqCount < count($allParams) ? ' (required params only)' : ''),
          'code' => $reqCall,
        ];
      }

      // Caso 2: Todos los parámetros (si hay opcionales)
      if (count($allParams) > $reqCount) {
        $allArgs = [];
        foreach ($allParams as $p) {
          if ($p->isVariadic()) {
            $sv = sampleValue($p->hasType() ? (string)$p->getType() : '', $p->getName());
            $allArgs[] = $sv . ', ' . $sv;
          } elseif ($p->isDefaultValueAvailable()) {
            $dv = $p->getDefaultValue();
            $allArgs[] = is_string($dv) ? "'" . addslashes($dv) . "'" : var_export($dv, true);
          } else {
            $allArgs[] = sampleValue($p->hasType() ? (string)$p->getType() : '', $p->getName());
          }
        }
        $fullCall = "\\$result = {$name}(" . implode(', ', $allArgs) . ");";
        $examples[] = [
          'title' => 'With all parameters',
          'code' => $fullCall,
        ];
      }

      // Caso 3: Uso con variable + var_dump
      if ($rf->hasReturnType()) {
        $rt = (string)$rf->getReturnType();
        $simpleArgs = implode(', ', $reqArgs);
        if (str_contains($rt, 'string')) {
          $examples[] = [
            'title' => 'Using the return value',
            'code' => "\\$output = {$name}({$simpleArgs});\\necho \\$output; // string",
          ];
        } elseif (str_contains($rt, 'array')) {
          $examples[] = [
            'title' => 'Iterating the result',
            'code' => "\\$items = {$name}({$simpleArgs});\\nforeach (\\$items as \\$key => \\$val) {\\n    echo \\\"\\$key: \\$val\\\\n\\\";\\n}",
          ];
        } elseif (str_contains($rt, 'bool')) {
          $examples[] = [
            'title' => 'Conditional check',
            'code' => "if ({$name}({$simpleArgs})) {\\n    echo 'Condition met';\\n} else {\\n    echo 'Condition not met';\\n}",
          ];
        } elseif (str_contains($rt, 'int') || str_contains($rt, 'float')) {
          $examples[] = [
            'title' => 'Numeric result',
            'code' => "\\$n = {$name}({$simpleArgs});\\necho \\\"Result: \\$n\\\";",
          ];
        }
      }

      // Caso 4: Error handling si la función puede fallar
      $canFail = str_contains(strtolower($name), 'file') || str_contains(strtolower($name), 'open')
        || str_contains(strtolower($name), 'connect') || str_contains(strtolower($name), 'read')
        || str_contains(strtolower($name), 'write') || str_contains(strtolower($name), 'json')
        || str_contains(strtolower($name), 'curl') || str_contains(strtolower($name), 'preg');
      if ($canFail) {
        $simpleArgs = implode(', ', $reqArgs);
        $examples[] = [
          'title' => 'Error handling',
          'code' => "\\$result = {$name}({$simpleArgs});\\nif (\\$result === false) {\\n    echo 'Error: operation failed';\\n}",
        ];
      }

      $result = [
        'name' => $rf->getName(),
        'params' => $params,
        'returnType' => $rf->hasReturnType() ? (string)$rf->getReturnType() : null,
        'extension' => $rf->getExtensionName() ?: 'Core',
        'deprecated' => $rf->isDeprecated(),
        'numRequired' => $rf->getNumberOfRequiredParameters(),
        'numTotal' => $rf->getNumberOfParameters(),
        'returnsRef' => $rf->returnsReference(),
        'examples' => $examples,
      ];
      echo json_encode($result);
    } catch (Exception $e) {
      echo json_encode(['error' => $e->getMessage()]);
    }
  `;

  try {
    const res = await runProjectCommand('php', ['-r', phpScript],
      projectCapabilities.projectRoot || process.cwd());
    if (res.error && !res.output) return { detail: null, error: res.error };
    const parsed = JSON.parse(res.output);
    if (parsed.error) return { detail: null, error: parsed.error };
    return { detail: parsed };
  } catch (e) {
    return { detail: null, error: e.message };
  }
});

// ────────────────────────────────────────────
// 14. IPC HANDLERS — LARAVEL ROUTE LIST
// ────────────────────────────────────────────
ipcMain.handle('laravel:routeList', async (event) => {
  if (!projectCapabilities.projectRoot || !projectCapabilities.hasArtisan) {
    return { error: 'Not a Laravel project' };
  }
  return runProjectCommand('php', ['artisan', 'route:list', '--json', '--no-interaction'], projectCapabilities.projectRoot);
});

// ────────────────────────────────────────────────────────────────
// 14b. IPC HANDLERS — SLIM ROUTE PARSER
// ────────────────────────────────────────────────────────────────
//
// Slim 3/4 no tiene un CLI para listar rutas. En vez de eso,
// parseamos los archivos PHP del proyecto buscando patrones de
// definición de rutas: $app->get(), $app->post(), $group(), etc.
// También detecta rutas registradas en archivos de configuración
// como routes.php, web.php, api.php, etc.
//
// Busca recursivamente en:
//   - src/routes/  (convención Slim skeleton)
//   - routes/      (convención alternativa)
//   - app/         (proyectos custom)
//   - Archivo raíz index.php, routes.php
// ────────────────────────────────────────────────────────────────

/**
 * Parsea rutas Slim desde los archivos PHP del proyecto.
 *
 * Busca patrones como:
 *   $app->get('/path', handler)
 *   $app->post('/path', 'Controller:method')
 *   $app->group('/prefix', function() { ... })
 *   $this->get('/path', handler)   (dentro de groups)
 *
 * @returns {{ routes: Array<{method, uri, handler, file, line}>, error?: string }}
 */
ipcMain.handle('slim:routeList', async () => {
  const root = projectCapabilities.projectRoot;
  if (!root) return { routes: [], error: 'No project open' };

  // ── Encontrar archivos PHP candidatos ──
  const candidates = [];
  const routeDirs = ['routes', 'src/routes', 'app', 'app/routes', 'src'];
  const rootFiles = ['routes.php', 'index.php', 'public/index.php', 'app.php'];

  // Archivos raíz
  for (const f of rootFiles) {
    const full = path.join(root, f);
    if (fs.existsSync(full)) candidates.push(full);
  }

  // Directorios de rutas (buscar .php recursivamente, max 3 niveles)
  for (const dir of routeDirs) {
    const full = path.join(root, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      collectPhpFiles(full, candidates, 0, 3);
    }
  }

  if (!candidates.length) return { routes: [], error: 'No route files found' };

  // ── Parsear rutas de cada archivo ──
  const routes = [];
  const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'map'];
  // Regex para: $app->method('/uri', handler)  o  $this->method('/uri', handler)
  //             $app->group('/prefix', ...)
  const routeRe = /(?:\$app|\$this|\$group)\s*->\s*(get|post|put|patch|delete|options|any|map|group)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const relPath = path.relative(root, filePath).replace(/\\/g, '/');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m;
        routeRe.lastIndex = 0;
        while ((m = routeRe.exec(line)) !== null) {
          const method = m[1].toUpperCase();
          const uri = m[2];

          // Intentar extraer el handler del resto de la línea
          let handler = '';
          const afterUri = line.slice(m.index + m[0].length);
          // Patrón: 'Controller:method' o Controller::class
          const handlerMatch = afterUri.match(/,\s*['"`]([^'"`]+)['"`]/) ||
                                afterUri.match(/,\s*([\w\\]+::class)/) ||
                                afterUri.match(/,\s*\[([\w\\]+)::class,\s*['"`](\w+)['"`]\]/);
          if (handlerMatch) {
            handler = handlerMatch[2]
              ? `${handlerMatch[1]}::${handlerMatch[2]}`
              : handlerMatch[1];
          } else if (afterUri.match(/,\s*function/)) {
            handler = 'Closure';
          }

          routes.push({
            method: method === 'GROUP' ? 'GROUP' : method,
            uri,
            handler,
            file: relPath,
            line: i + 1,
          });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return { routes };
});

/**
 * Recorre un directorio recursivamente recolectando archivos .php.
 * @param {string} dir - Directorio a recorrer
 * @param {string[]} out - Array donde acumular paths
 * @param {number} depth - Profundidad actual
 * @param {number} maxDepth - Profundidad máxima
 */
function collectPhpFiles(dir, out, depth, maxDepth) {
  if (depth > maxDepth) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'vendor' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectPhpFiles(full, out, depth + 1, maxDepth);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        out.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
}

// ────────────────────────────────────────────
// 15. IPC HANDLERS — CLAUDE PANEL
//     Lee el directorio .claude del proyecto para
//     mostrar skills y agentes custom en el sidebar.
//
//     ESTRUCTURA QUE ENTIENDE:
//       .claude/skills/*/SKILL.md   → skills con frontmatter YAML
//       .claude/commands/*.md       → slash commands del proyecto
//       .claude/agents/*.md         → agentes custom con frontmatter
//
//     El directorio .claude puede no estar en la carpeta
//     que el usuario abrió: sube por el filesystem hasta
//     encontrarlo (mismo comportamiento de Claude Code).
// ────────────────────────────────────────────

/**
 * Lee y parsea el directorio .claude del proyecto abierto.
 *
 * Devuelve un objeto con dos listas:
 *   - skills: skills custom + slash commands del proyecto
 *   - agents: agentes custom con metadata (modelo, color, herramientas)
 *
 * Cada item incluye el `body` (contenido del .md sin el frontmatter)
 * para mostrarlo en el dashboard de detalle al hacer click en el sidebar.
 *
 * @param {string} folder - Carpeta abierta en el editor (state.currentFolder del renderer)
 * @returns {Object} { exists, projectRoot, skills[], agents[] } o { error }
 */
ipcMain.handle('claude:read', async (event, folder) => {
  if (!folder) return { error: 'No folder open' };

  // Buscar .claude subiendo desde la carpeta abierta hasta la raíz del filesystem.
  //
  // Claude Code coloca .claude en la raíz git del proyecto, que puede no coincidir
  // con la carpeta que el usuario abrió. Por ejemplo, si abrió src/ dentro de un
  // monorepo, .claude está dos niveles más arriba.
  //
  // Usamos el mismo algoritmo que Claude Code: subir directorio por directorio
  // hasta encontrar .claude o llegar a la raíz del filesystem.
  let claudeDir = null;
  let projectRoot = null;
  let current = folder;
  while (true) {
    const candidate = path.join(current, '.claude');
    if (fs.existsSync(candidate)) {
      claudeDir = candidate;
      projectRoot = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // raíz del filesystem — no encontrado
    current = parent;
  }

  /**
   * Parsea el frontmatter YAML de un archivo .md.
   * Solo soporta el subset que usa Claude Code: key: value en líneas simples.
   * No intenta parsear arrays, objetos anidados ni strings multilinea.
   *
   * @param {string} content - Contenido completo del archivo .md
   * @returns {Object} Pares clave-valor del frontmatter
   */
  function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const fm = {};
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.+)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
    return fm;
  }

  /**
   * Extrae el cuerpo del archivo: todo lo que viene después del bloque ---frontmatter---
   * Este es el contenido Markdown que se muestra en el dashboard de detalle.
   *
   * @param {string} content - Contenido completo del archivo .md
   * @returns {string} Cuerpo sin frontmatter, con whitespace inicial removido
   */
  function extractBody(content) {
    return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  }

  try {
    if (!claudeDir) return { exists: false };

    const result = {
      exists: true,
      projectRoot,
      skills: [],  // skills (.claude/skills/) + slash commands (.claude/commands/)
      agents: [],  // agentes custom (.claude/agents/)
    };

    // ── SKILLS: .claude/skills/*/SKILL.md ──────────────────────────────
    //
    // Cada skill vive en su propia carpeta:
    //   .claude/skills/laravel-migration/SKILL.md
    //   .claude/skills/check-logs/SKILL.md
    //
    // El frontmatter define: name, description, version, tools
    // El body contiene las instrucciones completas para Claude
    const skillsDir = path.join(claudeDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const skillFolder of fs.readdirSync(skillsDir).sort()) {
        const skillMd = path.join(skillsDir, skillFolder, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;
        const content = fs.readFileSync(skillMd, 'utf8');
        const fm = parseFrontmatter(content);
        result.skills.push({
          name:        fm.name || skillFolder,
          description: fm.description || '',
          version:     fm.version || null,
          tools:       fm.tools || null,
          body:        extractBody(content),
        });
      }
    }

    // ── SLASH COMMANDS: .claude/commands/*.md ──────────────────────────
    //
    // Los comandos son archivos .md en la raíz de commands/ (no subcarpetas):
    //   .claude/commands/deploy.md  →  /deploy
    //   .claude/commands/review.md  →  /review
    //
    // Se agregan a la misma lista de skills pero con isCommand: true
    // para que el renderer los muestre con el prefijo "/" y en teal
    const commandsDir = path.join(claudeDir, 'commands');
    if (fs.existsSync(commandsDir)) {
      for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md')).sort()) {
        const content = fs.readFileSync(path.join(commandsDir, file), 'utf8');
        const fm = parseFrontmatter(content);
        // La descripción puede venir del frontmatter (clave "description")
        // o de la primera línea no vacía del archivo (título # del comando)
        const fallbackDesc = content.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') || '';
        result.skills.push({
          name:        '/' + file.replace('.md', ''),
          description: fm.description || fallbackDesc,
          version:     null,
          tools:       fm['allowed-tools'] || null,
          isCommand:   true,
          body:        extractBody(content),
        });
      }
    }

    // ── AGENTES: .claude/agents/*.md ──────────────────────────────────
    //
    // Cada agente es un archivo .md con frontmatter:
    //   name        → identificador del agente
    //   description → cuándo y para qué usarlo
    //   model       → override del modelo (sonnet / opus / haiku)
    //   color       → color visual del dot en la UI (red/green/yellow/blue/cyan)
    //   tools       → herramientas disponibles para el agente
    const agentsDir = path.join(claudeDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      for (const file of fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md')).sort()) {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
        const fm = parseFrontmatter(content);
        result.agents.push({
          name:        fm.name || file.replace('.md', ''),
          description: fm.description || '',
          model:       fm.model || null,
          color:       fm.color || null,
          tools:       fm.tools || null,
          body:        extractBody(content),
        });
      }
    }

    return result;
  } catch (e) {
    return { error: e.message };
  }
});

// ────────────────────────────────────────────────────────────────
// 16b. IPC HANDLERS — CLAUDE HISTORY
//      Lee el historial de conversaciones del proyecto desde
//      ~/.claude/projects/{encoded-path}/*.jsonl y devuelve
//      los últimos 10 prompts humanos con su respuesta.
// ────────────────────────────────────────────────────────────────

/**
 * Devuelve los últimos 10 prompts humanos del proyecto con su respuesta.
 *
 * CÓMO FUNCIONA:
 * ──────────────
 * Claude Code guarda cada sesión como un archivo JSONL en:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * Donde <encoded-path> es la ruta del proyecto con '/' Y '.' reemplazados
 * por '-' (incluyendo la barra inicial), por ejemplo:
 *   /Users/ivan/projects/my.app  →  -Users-ivan-projects-my-app
 *
 * Cada línea del JSONL es un mensaje con estructura:
 *   { type: 'user'|'assistant'|'system'|..., uuid, parentUuid, timestamp, message }
 *
 * Los mensajes 'user' con content de texto son los prompts humanos reales.
 * Los mensajes 'user' con content de tipo 'tool_result' son respuestas
 * automáticas a herramientas — se filtran.
 *
 * OBTENCIÓN DE LA RESPUESTA:
 * ──────────────────────────
 * La conversación forma un árbol de mensajes vinculados por parentUuid.
 * Para encontrar la respuesta a un prompt, seguimos la cadena:
 *   user (prompt) → assistant (thinking) → user (tool_result) → assistant (texto)
 * Continuamos hasta encontrar el primer bloque 'text' no vacío en un
 * mensaje assistant, ignorando los bloques 'thinking' de extended thinking.
 *
 * ENCODING DE RUTA:
 * ─────────────────
 * Claude Code usa match exacto de carpeta — no hay walk-up. Se resuelven
 * symlinks y se normaliza el trailing slash para cubrir variaciones.
 * El encoding reemplaza '/' Y '.' con '-' (descubierto empíricamente en
 * proyectos con nombres como puntosflex.2026).
 *
 * @param {string} folder - Carpeta del proyecto (state.currentFolder del renderer)
 * @returns {{ prompts: Array<{uuid, prompt, response, timestamp, sessionId}> }}
 *          Array ordenado por timestamp desc, máximo 10 items.
 *          En caso de error devuelve { error: string }.
 */
ipcMain.handle('claude:history', async (event, folder) => {
  if (!folder) return { error: 'No folder open' };

  try {
    // ── Localizar la carpeta de historial del proyecto ─────────────────
    //
    // Claude Code guarda las sesiones en ~/.claude/projects/<encoded-path>/
    // donde <encoded-path> es la ruta del proyecto con '/' → '-'.
    //
    // Ejemplo: /Users/ivan/projects/myapp → -Users-ivan-projects-myapp
    //
    // Usamos match exacto (sin walk-up) porque el historial de un
    // directorio padre pertenece a OTRO proyecto.
    //
    // Se resuelven symlinks y se normaliza la ruta para cubrir
    // variaciones como trailing slashes o links simbólicos.
    const homeDir = os.homedir();
    const projectsBase = path.join(homeDir, '.claude', 'projects');

    // Claude Code codifica la ruta reemplazando tanto '/' como '.' por '-'.
    // Ejemplo: /Users/ivan/sites/my.app → -Users-ivan-sites-my-app
    function encodePath(p) {
      return p.replace(/\/+$/, '').replace(/[/.]/g, '-');
    }

    // Intentar con la ruta tal cual y con la ruta resuelta (symlinks)
    const candidates = [
      folder.replace(/\/+$/, ''),  // sin trailing slash
    ];
    try {
      const resolved = fs.realpathSync(folder).replace(/\/+$/, '');
      if (resolved !== candidates[0]) candidates.push(resolved);
    } catch (_) { /* no-op si realpathSync falla */ }

    let claudeProjectsDir = null;
    for (const candidate of candidates) {
      const encoded = encodePath(candidate);
      const dir = path.join(projectsBase, encoded);
      if (fs.existsSync(dir)) {
        const hasJsonl = fs.readdirSync(dir).some((f) => f.endsWith('.jsonl'));
        if (hasJsonl) {
          claudeProjectsDir = dir;
          break;
        }
      }
    }

    if (!claudeProjectsDir) {
      return { prompts: [] };
    }

    // ── Leer todos los archivos .jsonl de la sesión ──────────────────────
    //
    // Cada archivo .jsonl corresponde a una sesión de conversación.
    // Leemos todos y fusionamos los mensajes en un pool único.
    const jsonlFiles = fs.readdirSync(claudeProjectsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(claudeProjectsDir, f));

    if (!jsonlFiles.length) return { prompts: [] };

    // byUuid: mapa de todos los mensajes indexados por su uuid
    // childrenMap: mapa de parentUuid → array de mensajes hijo
    const byUuid      = {};
    const childrenMap = {};

    for (const file of jsonlFiles) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (_) {
        continue;
      }

      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch (_) { continue; }

        const uid = obj.uuid;
        if (!uid) continue;

        byUuid[uid] = obj;

        const parent = obj.parentUuid;
        if (parent) {
          if (!childrenMap[parent]) childrenMap[parent] = [];
          childrenMap[parent].push(obj);
        }
      }
    }

    // ── Filtrar los prompts humanos reales ───────────────────────────────
    //
    // Criterios para que un mensaje 'user' sea un prompt humano:
    //   1. type === 'user'
    //   2. message.content es un string con texto, O es un array que contiene
    //      al menos un bloque de type:'text' y NO contiene type:'tool_result'
    //      (los tool_result son respuestas automáticas a herramientas, no del usuario)
    const humanPrompts = [];

    for (const obj of Object.values(byUuid)) {
      if (obj.type !== 'user') continue;

      const msg     = obj.message || {};
      const content = msg.content;
      let promptText = '';

      if (typeof content === 'string') {
        promptText = content.trim();
      } else if (Array.isArray(content)) {
        // Descartar si hay algún tool_result — son respuestas automáticas
        const hasToolResult = content.some((c) => c && c.type === 'tool_result');
        if (hasToolResult) continue;

        // Extraer texto de los bloques type:'text'
        for (const block of content) {
          if (block && block.type === 'text' && block.text) {
            promptText += block.text;
          }
        }
        promptText = promptText.trim();
      }

      // Filtrar mensajes vacíos y mensajes de sistema embebidos
      // (local-command-caveat, command-name, etc.)
      if (!promptText) continue;
      if (promptText.startsWith('<local-command-caveat>')) continue;
      if (promptText.startsWith('<command-name>')) continue;
      if (promptText.startsWith('<local-command-stdout>')) continue;
      if (promptText.startsWith('This session is being continued')) continue;

      humanPrompts.push({
        uuid:      obj.uuid,
        text:      promptText,
        timestamp: obj.timestamp || '',
        sessionId: obj.sessionId || '',
      });
    }

    // ── Para cada prompt, obtener la primera respuesta de texto ──────────
    //
    // La cadena de mensajes en Claude Code es:
    //   user (prompt) → assistant (puede ser solo thinking) →
    //   user (tool_result) → assistant (más thinking o texto) → ...
    //
    // Para encontrar la respuesta real, seguimos la cadena saltando
    // tanto por mensajes assistant (que pueden no tener texto) como
    // por mensajes user/system intermedios (tool results, etc.).
    //
    // Se ignoran los bloques 'thinking' (extended thinking de Opus).
    // Tomamos el primer bloque de texto encontrado.
    function getAssistantResponse(promptUuid) {
      let currentUuid = promptUuid;
      const MAX_STEPS = 80;
      let steps = 0;

      while (steps < MAX_STEPS) {
        const children = childrenMap[currentUuid] || [];
        if (!children.length) break;

        // Priorizar encontrar un assistant con texto
        for (const child of children) {
          if (child.type === 'assistant') {
            const content = child.message?.content || [];
            for (const block of content) {
              if (block && block.type === 'text' && block.text?.trim()) {
                return block.text.trim();
              }
            }
          }
        }

        // No encontramos texto — avanzar al primer hijo para seguir la cadena.
        // En la conversación lineal, el primer hijo es el siguiente mensaje
        // (ya sea assistant sin texto, user con tool_result, o system).
        currentUuid = children[0].uuid;
        steps++;
      }

      return '';
    }

    // ── Ensamblar resultado: ordenar por timestamp desc, tomar 10 ────────
    humanPrompts.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
    const last10 = humanPrompts.slice(0, 10);

    return {
      prompts: last10.map((p) => {
        let response = getAssistantResponse(p.uuid);
        // Filtrar respuestas que son errores de API (no son útiles para el usuario)
        if (response.startsWith('API Error:')) response = '';
        return {
          uuid:      p.uuid,
          prompt:    p.text,
          response,
          timestamp: p.timestamp,
          sessionId: p.sessionId,
        };
      }),
    };
  } catch (e) {
    return { error: e.message };
  }
});

// ────────────────────────────────────────────
// 16. IPC HANDLERS — COMPOSER & ARTISAN
//     Ejecuta comandos de Composer y Artisan en el proyecto
// ────────────────────────────────────────────

// Detectar capabilities cuando se abre una carpeta
ipcMain.on('project:detect', (event, folderPath) => {
  detectProjectCapabilities(folderPath);
});

// Ejecutar comando de Composer
ipcMain.handle('composer:exec', async (event, subcommand, args) => {
  if (!projectCapabilities.projectRoot) return { error: 'No project open' };
  const cmdArgs = [subcommand, ...(args ? args.split(/\s+/) : [])];
  // Agregar --no-interaction para evitar prompts
  if (!cmdArgs.includes('--no-interaction') && !cmdArgs.includes('-n')) {
    cmdArgs.push('--no-interaction');
  }
  // Agregar --ansi para colores
  if (!cmdArgs.includes('--ansi') && !cmdArgs.includes('--no-ansi')) {
    cmdArgs.push('--ansi');
  }
  return runProjectCommand('composer', cmdArgs, projectCapabilities.projectRoot);
});

// Crear un nuevo proyecto Laravel desde cero.
//
// Ejecuta: composer create-project laravel/laravel <nombre>
// en el directorio padre elegido por el usuario.
//
// El timeout es de 10 minutos (vs los 2 min del config normal)
// porque descargar todas las dependencias de Laravel puede tardar
// bastante dependiendo de la conexión y si no hay caché de Composer.
//
// Si el comando termina exitosamente, abre el nuevo proyecto
// automáticamente (file tree, detección de Artisan/Composer,
// reconstrucción de menús nativos).
ipcMain.handle('composer:createProject', async (event, parentDir, projectName) => {
  const args = ['create-project', 'laravel/laravel', projectName, '--no-interaction', '--ansi'];

  const result = await new Promise((resolve) => {
    execFile('composer', args, {
      cwd: parentDir,
      maxBuffer: config.exec.maxBuffer,
      timeout: 600000, // 10 minutos
      ...(process.platform === 'win32' ? { shell: true } : {}),
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ output: stdout, error: stderr || err.message, code: err.code });
      } else {
        resolve({ output: stdout, error: stderr || null, code: 0 });
      }
    });
  });

  // Si fue exitoso, abrir el proyecto recién creado en el editor
  if (result.code === 0 || (!result.error && result.output)) {
    const projectPath = path.join(parentDir, projectName);
    saveRecentFolder(projectPath);
    createMenu();
    mainWindow?.webContents.send('folder:opened', projectPath);
  }

  return result;
});

// Diálogo para elegir una carpeta destino (usado por New Laravel Project).
// Separado del openFolder porque tiene título y botón distintos,
// y NO abre la carpeta como proyecto — solo devuelve la ruta.
ipcMain.handle('dialog:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choose folder for new project',
    buttonLabel: 'Select Folder',
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

// Ejecutar comando de Artisan
ipcMain.handle('artisan:exec', async (event, subcommand, args) => {
  if (!projectCapabilities.projectRoot) return { error: 'No project open' };
  const cmdArgs = ['artisan', subcommand, ...(args ? args.split(/\s+/) : [])];
  // Agregar --no-interaction para evitar prompts
  if (!cmdArgs.includes('--no-interaction') && !cmdArgs.includes('-n')) {
    cmdArgs.push('--no-interaction');
  }
  // Agregar --ansi para colores
  if (!cmdArgs.includes('--ansi') && !cmdArgs.includes('--no-ansi')) {
    cmdArgs.push('--ansi');
  }
  return runProjectCommand('php', cmdArgs, projectCapabilities.projectRoot);
});

// ────────────────────────────────────────────
// 17. IPC HANDLERS — WINDOW CONTROLS (custom titlebar)
//     Minimize, maximize/restore, close
// ────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:new', () => spawnNewWindow());

// ── Hamburger menu: ejecutar un item del menú por su path de labels ──
// El renderer envía ['File', 'Save'] y buscamos el item en el menú nativo.
ipcMain.on('menu:execute', (event, labelPath) => {
  const appMenu = Menu.getApplicationMenu();
  if (!appMenu) return;
  let items = appMenu.items;
  for (let i = 0; i < labelPath.length; i++) {
    const item = items.find(m => m.label === labelPath[i]);
    if (!item) return;
    if (i === labelPath.length - 1) {
      // Ejecutar el click del item encontrado
      if (item.click) item.click(item, mainWindow, event);
    } else if (item.submenu) {
      items = item.submenu.items;
    } else {
      return;
    }
  }
});

// ── Hamburger menu: pedir re-envío de estructura del menú ──
ipcMain.on('menu:requestStructure', () => {
  const appMenu = Menu.getApplicationMenu();
  if (appMenu && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('menu:structure', serializeMenu(appMenu));
  }
});

// ────────────────────────────────────────────
// 17. APP LIFECYCLE — Inicio, activación y cierre de Electron
//     whenReady → crea menú y ventana; gestiona quit y cleanup
// ────────────────────────────────────────────
  // app.whenReady() se resuelve cuando Electron terminó de inicializar
  // y el GPU process está listo. Es el punto de entrada principal:
  // primero armamos el menú nativo, después creamos la ventana.
  app.whenReady().then(() => {
    createMenu();
    createWindow();

    // macOS: re-crear ventana al clickear el dock icon si no hay ninguna abierta
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

// Salir cuando se cierran todas las ventanas (excepto macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup del pty y LSP al cerrar
app.on('before-quit', () => {
  for (const proc of ptyProcesses.values()) {
    try { proc.kill(); } catch { /* already exited */ }
  }
  ptyProcesses.clear();
  if (lspManager) { lspManager.stop(); lspManager = null; }
  if (tsLspManager) { tsLspManager.stop(); tsLspManager = null; }
});
