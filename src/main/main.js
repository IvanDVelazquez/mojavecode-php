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
const { execFile, execSync } = require('child_process');
const config = require('../config');
const db = require('./db-helper');

// ── Fix PATH para apps empaquetadas en macOS ──
// Cuando Electron corre como .app, el PATH es mínimo (/usr/bin:/bin:/usr/sbin:/sbin).
// Binarios como php, mysql, composer (instalados via Homebrew, MAMP, Herd, etc.)
// no se encuentran. Reconstruimos el PATH desde las fuentes del sistema + paths comunes.
if (app.isPackaged && process.platform === 'darwin') {
  const home = os.homedir();
  // Paths comunes donde viven binarios de desarrollo en macOS
  const extraPaths = [
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
  ];

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

  // Filtrar solo paths que existen y agregar al PATH actual
  const existing = extraPaths.filter((p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  });
  process.env.PATH = [...new Set([...existing, ...process.env.PATH.split(':')])].join(':');
}

// ── Carpetas recientes ──
// Se guardan en un JSON en userData para que el menú nativo
// pueda leerlas sincrónicamente al construirse.
const RECENT_FILE = path.join(app.getPath('userData'), 'recent-folders.json');
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

let mainWindow;
let ptyProcess;
let lspManager = null;

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
  formatOnSave: false, // desactivado por defecto
  autoSave: false, // auto-save desactivado por defecto
  projectRoot: null,
};

// ────────────────────────────────────────────
// 1. VENTANA PRINCIPAL — BrowserWindow con custom titlebar
//    Configura frame, preload, seguridad y DevTools
// ────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    minWidth: config.window.minWidth,
    minHeight: config.window.minHeight,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: config.window.bg,
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



  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ptyProcess) ptyProcess.kill();
  });
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
              sublabel: folderPath.replace(/^\/Users\/[^/]+/, '~'),
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
        ...(projectCapabilities.hasArtisan ? [{
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
              message: 'MojaveCode PHP v2.7.3',
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
}

// ────────────────────────────────────────────
// 2b. DETECCIÓN DE PROYECTO — Composer, Artisan, Laravel Modules
//     Escanea el root del proyecto para habilitar menús dinámicos
// ────────────────────────────────────────────
function detectProjectCapabilities(folderPath) {
  projectCapabilities.projectRoot = folderPath;
  projectCapabilities.hasComposer = fs.existsSync(path.join(folderPath, 'composer.json'));
  projectCapabilities.hasArtisan = fs.existsSync(path.join(folderPath, 'artisan'));

  // Detectar nwidart/laravel-modules
  projectCapabilities.hasModules = false;
  if (projectCapabilities.hasComposer) {
    try {
      const composerJson = JSON.parse(fs.readFileSync(path.join(folderPath, 'composer.json'), 'utf-8'));
      const allDeps = { ...composerJson.require, ...composerJson['require-dev'] };
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

  // Detectar Laravel Sail (vendor/bin/sail)
  //
  // Sail es la forma oficial de Laravel para correr el proyecto en Docker.
  // Cuando está disponible y es un proyecto Sail real, usamos ./vendor/bin/sail
  // en lugar de docker exec.
  //
  // IMPORTANTE: Un proyecto puede tener vendor/bin/sail instalado como dependencia
  // pero correr en un Docker custom (no Sail). Para distinguirlo, exigimos que
  // el docker-compose.yml esté en la RAÍZ del proyecto Laravel (mismo dir que artisan).
  // Si el compose está en un directorio padre, es un setup Docker propio → docker exec.
  projectCapabilities.hasSail = fs.existsSync(path.join(folderPath, 'vendor', 'bin', 'sail'))
    && fs.existsSync(path.join(folderPath, 'docker-compose.yml'));
  projectCapabilities.sailEnabled = projectCapabilities.hasSail; // auto-activar al detectar

  // Detectar Docker — buscar docker-compose.yml subiendo directorios
  projectCapabilities.hasDocker = false;
  projectCapabilities.dockerEnv = false;
  projectCapabilities.dockerContainer = null;
  projectCapabilities.dockerWorkdir = null;

  const composePath = findDockerCompose(folderPath);
  if (composePath) {
    projectCapabilities.hasDocker = true;
    const dockerConfig = parseDockerConfig(composePath, folderPath);
    if (dockerConfig) {
      projectCapabilities.dockerContainer = dockerConfig.containerName;
      projectCapabilities.dockerWorkdir = dockerConfig.workdir;
    }
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
 * Buscar docker-compose.yml subiendo directorios desde folderPath.
 * Retorna la ruta al archivo o null si no se encuentra.
 */
function findDockerCompose(folderPath) {
  let dir = folderPath;
  const root = path.parse(dir).root;
  while (dir !== root) {
    for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    dir = path.dirname(dir);
  }
  return null;
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
    const sailBin = './vendor/bin/sail';
    if (cmd === 'php' && args[0] === 'artisan') {
      return runCommand(sailBin, args, cwd); // args ya empieza con 'artisan'
    }
    if (cmd === 'composer') {
      return runCommand(sailBin, [cmd, ...args], cwd);
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
 * Devuelve { output, error, code }
 */
function runCommand(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: config.exec.maxBuffer, timeout: config.exec.timeout }, (err, stdout, stderr) => {
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
 */
ipcMain.handle('watch:add', (event, filePath) => {
  if (fileWatchers.has(filePath)) return;
  try {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType !== 'change') return;
      if (recentlySaved.has(filePath)) return;

      // Debounce: ignorar disparos duplicados del mismo evento
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
 * Copiar un archivo o carpeta a una nueva ubicación.
 *
 * Para carpetas usa `cp` recursivo (copia todo el árbol).
 * El renderer determina el destPath (agrega " - Copy" si ya existe).
 */
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
    const allLines = content.split('\n');
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
ipcMain.handle('pty:spawn', (event, cwd) => {
  if (!pty) {
    return { error: 'node-pty not available' };
  }

  // Matar pty anterior si existe
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch { /* already exited */ }
    ptyProcess = null;
  }

  // Detectar la shell del SO
  const shell = process.platform === 'win32'
    ? 'powershell.exe'
    : process.env.SHELL || '/bin/bash';

  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || os.homedir(),
      env: process.env,
    });

    // Cuando el pty produce output, se lo mandamos al renderer
    ptyProcess.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', data);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', exitCode);
      }
    });

    return { success: true, pid: ptyProcess.pid };
  } catch (err) {
    return { error: err.message };
  }
});

// El renderer escribe en el pty (el usuario tipea en xterm.js)
ipcMain.on('pty:write', (event, data) => {
  if (ptyProcess) {
    ptyProcess.write(data);
  }
});

// El renderer cambia el tamaño de xterm → resize del pty
ipcMain.on('pty:resize', (event, { cols, rows }) => {
  if (ptyProcess) {
    try {
      ptyProcess.resize(cols, rows);
    } catch (e) {
      // Puede fallar si el pty ya se cerró
    }
  }
});

// Matar el pty actual (cuando el usuario cierra la terminal tab)
// Permite que al reabrir se inicie una terminal completamente nueva
ipcMain.handle('pty:kill', () => {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch { /* already exited */ }
    ptyProcess = null;
  }
  return { success: true };
});

// Cambiar directorio del pty de forma segura (evita inyección de comandos)
ipcMain.on('pty:cd', (event, cwd) => {
  if (ptyProcess && cwd) {
    // Use single quotes to prevent shell expansion, escape any single quotes in path
    const safePath = cwd.replace(/'/g, "'\\''");
    ptyProcess.write(`cd '${safePath}'\n`);
  }
});

// ────────────────────────────────────────────
// 6. IPC HANDLERS — GIT (operaciones de repositorio)
//    branch, status, add, commit, diff, log, graph
// ────────────────────────────────────────────
function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: config.exec.maxBuffer }, (err, stdout, stderr) => {
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

        const lines = content.split('\n');
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
        const lines = content.split('\n');

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
      // Convertir ruta local a ruta dentro del contenedor
      const relative = path.relative(root, filePath);
      const containerFile = path.posix.join(dockerWorkdir, relative);
      return runProjectCommand('vendor/bin/pint', [containerFile, '--no-interaction'], root);
    }
    const pintBin = path.join(root, 'vendor', 'bin', 'pint');
    return runCommand(pintBin, [filePath, '--no-interaction'], root);
  } else if (projectCapabilities.hasCsFixer) {
    if (dockerContainer && dockerWorkdir) {
      const relative = path.relative(root, filePath);
      const containerFile = path.posix.join(dockerWorkdir, relative);
      return runProjectCommand('vendor/bin/php-cs-fixer', ['fix', containerFile, '--no-interaction', '--quiet'], root);
    }
    const fixerBin = path.join(root, 'vendor', 'bin', 'php-cs-fixer');
    return runCommand(fixerBin, ['fix', filePath, '--no-interaction', '--quiet'], root);
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
  const phpunitBin = path.join(root, 'vendor', 'bin', 'phpunit');
  const cmdArgs = [...(args || []), '--colors=always'];
  return runCommand(phpunitBin, cmdArgs, root);
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
        execFile('pg_dump', args, { env: pgEnv, timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
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
      execFile('mysqldump', args, { timeout: 120000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
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

// ────────────────────────────────────────────
// 14. IPC HANDLERS — LARAVEL ROUTE LIST
// ────────────────────────────────────────────
ipcMain.handle('laravel:routeList', async (event) => {
  if (!projectCapabilities.projectRoot || !projectCapabilities.hasArtisan) {
    return { error: 'Not a Laravel project' };
  }
  return runProjectCommand('php', ['artisan', 'route:list', '--json', '--no-interaction'], projectCapabilities.projectRoot);
});

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
    for (const line of match[1].split('\n')) {
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

      for (const line of content.split('\n')) {
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
  if (ptyProcess) {
    ptyProcess.kill();
  }
  if (lspManager) {
    lspManager.stop();
    lspManager = null;
  }
});
