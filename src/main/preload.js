/**
 * ══════════════════════════════════════════════════════════════
 * PRELOAD SCRIPT (preload.js)
 * ══════════════════════════════════════════════════════════════
 *
 * Este archivo es el PUENTE SEGURO entre el main process (Node.js)
 * y el renderer process (Chromium/DOM).
 *
 * ¿Por qué existe?
 * ─────────────────
 * Por seguridad, el renderer NO tiene acceso directo a Node.js APIs
 * (fs, child_process, etc). Si lo tuviera, cualquier XSS en tu UI
 * podría leer/escribir archivos del disco.
 *
 * El preload corre en un contexto especial: tiene acceso a algunas
 * APIs de Electron (como ipcRenderer) pero NO al DOM directamente.
 * Usa contextBridge para "exponer" funciones seguras al renderer.
 *
 * CÓMO FUNCIONA:
 * ─────────────────
 * 1. contextBridge.exposeInMainWorld('api', { ... })
 *    → Crea window.api en el renderer
 *
 * 2. El renderer llama: const files = await window.api.readDir('/path')
 *
 * 3. Eso ejecuta: ipcRenderer.invoke('fs:readDir', '/path')
 *    → Manda un mensaje al main process
 *
 * 4. El main process responde con los datos
 *    → ipcRenderer.invoke() devuelve una Promise con el resultado
 *
 * invoke() = request/response (como HTTP)
 * send()   = fire-and-forget (como WebSocket)
 * on()     = listener de eventos del main
 * ══════════════════════════════════════════════════════════════
 */

const { contextBridge, ipcRenderer } = require('electron');
const { getIcon } = require('material-file-icons');

contextBridge.exposeInMainWorld('api', {
  // ── Filesystem ──
  readDir: (dirPath) => ipcRenderer.invoke('fs:readDir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('fs:writeFile', filePath, content),
  stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),

  // ── File Watcher ──
  watchAdd: (filePath) => ipcRenderer.invoke('watch:add', filePath),
  watchRemove: (filePath) => ipcRenderer.invoke('watch:remove', filePath),
  watchClear: () => ipcRenderer.invoke('watch:clear'),
  onFileChanged: (callback) => ipcRenderer.on('file:changed', (event, path) => callback(path)),

  // ── File operations (context menu del file tree) ──
  deleteFile: (targetPath) => ipcRenderer.invoke('fs:deleteFile', targetPath),
  copyFile: (srcPath, destPath) => ipcRenderer.invoke('fs:copyFile', srcPath, destPath),

  // ── Carpetas recientes ──
  // Cuando el renderer abre una carpeta desde la welcome screen,
  // avisa al main para que actualice el JSON de recientes y
  // reconstruya el menú nativo (File > Open Recent).
  notifyRecentFolder: (folderPath) => ipcRenderer.send('recent:opened', folderPath),

  // ── Log Viewer (panel lateral de logs) ──
  listLogs: () => ipcRenderer.invoke('fs:listLogs'),
  readLogTail: (filePath, lines) => ipcRenderer.invoke('fs:readLogTail', filePath, lines),

  // ── Diálogos del SO ──
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveAs: (defaultPath) => ipcRenderer.invoke('dialog:saveAs', defaultPath),

  // ── Pseudo-terminal (pty) ──
  ptySpawn: (cwd) => ipcRenderer.invoke('pty:spawn', cwd),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  ptyCd: (cwd) => ipcRenderer.send('pty:cd', cwd),
  ptyKill: () => ipcRenderer.invoke('pty:kill'),
  onPtyData: (callback) => {
    ipcRenderer.on('pty:data', (event, data) => callback(data));
  },
  offPtyData: () => ipcRenderer.removeAllListeners('pty:data'),
  onPtyExit: (callback) => {
    ipcRenderer.on('pty:exit', (event, code) => callback(code));
  },
  offPtyExit: () => ipcRenderer.removeAllListeners('pty:exit'),

  // ── Window controls (custom titlebar) ──
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),

  // ── Menu events (main → renderer) ──
  onMenuSave: (callback) => ipcRenderer.on('menu:save', callback),
  // Auto Save: el main avisa al renderer cuando el usuario activa/desactiva
  // desde File > Auto Save. El renderer usa esto para activar el debounce.
  onAutoSaveChanged: (callback) => {
    ipcRenderer.on('menu:auto-save-changed', (event, enabled) => callback(enabled));
  },
  onMenuSaveAs: (callback) => ipcRenderer.on('menu:save-as', callback),
  onMenuToggleSidebar: (callback) => ipcRenderer.on('menu:toggle-sidebar', callback),
  onMenuToggleTerminal: (callback) => ipcRenderer.on('menu:toggle-terminal', callback),
  onMenuSwitchTheme: (callback) => {
    ipcRenderer.on('menu:switch-theme', (event, theme) => callback(theme));
  },
  onMenuZoomIn: (callback) => ipcRenderer.on('menu:zoom-in', callback),
  onMenuZoomOut: (callback) => ipcRenderer.on('menu:zoom-out', callback),
  onMenuZoomReset: (callback) => ipcRenderer.on('menu:zoom-reset', callback),

  onFolderOpened: (callback) => {
    ipcRenderer.on('folder:opened', (event, path) => callback(path));
  },
  onFileOpened: (callback) => {
    ipcRenderer.on('file:opened', (event, path) => callback(path));
  },

  listAllFiles: (rootDir) => ipcRenderer.invoke('fs:listAllFiles', rootDir),

  // ── Git ──
  gitBranch: (cwd) => ipcRenderer.invoke('git:branch', cwd),
  gitRootDir: (cwd) => ipcRenderer.invoke('git:rootDir', cwd),
  gitIsRepo: (cwd) => ipcRenderer.invoke('git:isRepo', cwd),
  gitStatus: (cwd) => ipcRenderer.invoke('git:status', cwd),
  gitAdd: (cwd, filePaths) => ipcRenderer.invoke('git:add', cwd, filePaths),
  gitUnstage: (cwd, filePaths) => ipcRenderer.invoke('git:unstage', cwd, filePaths),
  gitCommit: (cwd, message) => ipcRenderer.invoke('git:commit', cwd, message),
  gitDiff: (cwd, filePath, staged) => ipcRenderer.invoke('git:diff', cwd, filePath, staged),
  gitLog: (cwd, limit) => ipcRenderer.invoke('git:log', cwd, limit),
  gitDiscard: (cwd, filePath) => ipcRenderer.invoke('git:discard', cwd, filePath),
  gitShow: (cwd, filePath, ref) => ipcRenderer.invoke('git:show', cwd, filePath, ref),
  gitPush: (cwd) => ipcRenderer.invoke('git:push', cwd),
  gitPull: (cwd) => ipcRenderer.invoke('git:pull', cwd),
  gitGraphLog: (cwd, limit) => ipcRenderer.invoke('git:graphLog', cwd, limit),
  gitListBranches: (cwd) => ipcRenderer.invoke('git:listBranches', cwd),
  gitCheckout: (cwd, branch) => ipcRenderer.invoke('git:checkout', cwd, branch),

  // ── LSP (Language Server Protocol) ──
  lspStart: (workspaceFolder) => ipcRenderer.invoke('lsp:start', workspaceFolder),
  lspStop: () => ipcRenderer.invoke('lsp:stop'),
  lspRequest: (method, params) => ipcRenderer.invoke('lsp:request', method, params),
  lspNotify: (method, params) => ipcRenderer.send('lsp:notify', method, params),
  onLspNotification: (callback) => {
    ipcRenderer.on('lsp:notification', (event, message) => callback(message));
  },

  // ── PHP Format & PHPUnit ──
  phpResolvePsr4: (filePath) => ipcRenderer.invoke('php:resolvePsr4', filePath),
  phpFormat: (filePath) => ipcRenderer.invoke('php:format', filePath),
  toggleFormatOnSave: (enabled) => ipcRenderer.send('php:toggleFormatOnSave', enabled),
  onFormatOnSaveChanged: (callback) => {
    ipcRenderer.on('php:formatOnSaveChanged', (event, enabled) => callback(enabled));
  },
  phpunitRun: (args) => ipcRenderer.invoke('phpunit:run', args),
  onPhpunitRunAll: (callback) => ipcRenderer.on('phpunit:runAll', callback),
  onPhpunitRunFile: (callback) => ipcRenderer.on('phpunit:runFile', callback),
  onPhpunitRunMethod: (callback) => ipcRenderer.on('phpunit:runMethod', callback),

  // ── Sail / Docker ──
  // El main avisa al renderer cuando el usuario activa/desactiva Sail
  // desde el menú Artisan o Composer > Run via Sail.
  onSailChanged: (callback) => {
    ipcRenderer.on('sail:changed', (event, enabled) => callback(enabled));
  },

  // ── Menu events: Git ──
  onMenuGitCheckout: (callback) => ipcRenderer.on('menu:git-checkout', callback),

  // ── Menu events: DB & Routes ──
  onMenuDbViewer: (callback) => ipcRenderer.on('menu:db-viewer', callback),
  onMenuRouteList: (callback) => ipcRenderer.on('menu:route-list', callback),

  // ── Database Viewer ──
  dbGetConfig: () => ipcRenderer.invoke('db:getConfig'),
  dbGetConnections: () => ipcRenderer.invoke('db:getConnections'),
  dbGetTables: (connKey) => ipcRenderer.invoke('db:getTables', connKey),
  dbGetColumns: (table, connKey) => ipcRenderer.invoke('db:getColumns', table, connKey),
  dbQuery: (table, column, operator, value, limit, connKey) => ipcRenderer.invoke('db:query', table, column, operator, value, limit, connKey),
  dbUpdate: (table, pkCol, pkVal, col, newVal, connKey) => ipcRenderer.invoke('db:update', table, pkCol, pkVal, col, newVal, connKey),
  dbExecute: (sql, connKey) => ipcRenderer.invoke('db:execute', sql, connKey),
  dbExport: (type, tableName, connKey) => ipcRenderer.invoke('db:export', type, tableName, connKey),

  // ── Laravel Route List ──
  laravelRouteList: () => ipcRenderer.invoke('laravel:routeList'),

  // ── Claude Panel ──
  claudeRead: (folder) => ipcRenderer.invoke('claude:read', folder),
  // Devuelve los últimos 10 prompts del proyecto con sus respuestas
  claudeHistory: (folder) => ipcRenderer.invoke('claude:history', folder),

  // ── Search ──
  searchInFiles: (rootDir, query, options) => ipcRenderer.invoke('search:inFiles', rootDir, query, options),
  searchSymbols: (rootDir) => ipcRenderer.invoke('search:symbols', rootDir),
  onMenuSearch: (callback) => ipcRenderer.on('menu:search', callback),
  onMenuGoToSymbol: (callback) => ipcRenderer.on('menu:go-to-symbol', callback),

  // ── Composer & Artisan ──
  composerCreateProject: (parentDir, projectName) => ipcRenderer.invoke('composer:createProject', parentDir, projectName),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
  composerExec: (subcommand, args) => ipcRenderer.invoke('composer:exec', subcommand, args),
  artisanExec: (subcommand, args) => ipcRenderer.invoke('artisan:exec', subcommand, args),
  detectProject: (folderPath) => ipcRenderer.send('project:detect', folderPath),
  onProjectCapabilities: (callback) => {
    ipcRenderer.on('project:capabilities', (event, caps) => callback(caps));
  },
  // Composer menu events (main → renderer)
  onComposerNewLaravel: (callback) => {
    ipcRenderer.on('composer:new-laravel', callback);
  },
  onComposerRun: (callback) => {
    ipcRenderer.on('composer:run', (event, cmd) => callback(cmd));
  },
  onComposerPrompt: (callback) => {
    ipcRenderer.on('composer:prompt', (event, cmd) => callback(cmd));
  },
  // Artisan menu events (main → renderer)
  onArtisanRun: (callback) => {
    ipcRenderer.on('artisan:run', (event, cmd) => callback(cmd));
  },
  onArtisanPrompt: (callback) => {
    ipcRenderer.on('artisan:prompt', (event, cmd) => callback(cmd));
  },
  onArtisanTinker: (callback) => {
    ipcRenderer.on('artisan:tinker', callback);
  },

  // ── Utilidades ──
  platform: process.platform, // 'win32', 'darwin', 'linux'
  getFileIcon: (filename) => getIcon(filename).svg,
  syncTheme: (theme) => ipcRenderer.send('theme:sync', theme),
  syncCustomThemes: (themes) => ipcRenderer.send('theme:syncCustom', themes),
  onMenuGenerateTheme: (callback) => ipcRenderer.on('menu:generate-theme', callback),
  onMenuDeleteTheme: (callback) => {
    ipcRenderer.on('menu:delete-theme', (event, themeId) => callback(themeId));
  },
  getMemoryUsage: () => process.memoryUsage(),
  getCpuUsage: () => ipcRenderer.invoke('system:cpuUsage'),
});
