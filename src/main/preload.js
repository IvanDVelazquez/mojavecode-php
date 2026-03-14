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

  // ── Diálogos del SO ──
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  openFile: () => ipcRenderer.invoke('dialog:openFile'),
  saveAs: (defaultPath) => ipcRenderer.invoke('dialog:saveAs', defaultPath),

  // ── Pseudo-terminal (pty) ──
  ptySpawn: (cwd) => ipcRenderer.invoke('pty:spawn', cwd),
  ptyWrite: (data) => ipcRenderer.send('pty:write', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  ptyCd: (cwd) => ipcRenderer.send('pty:cd', cwd),
  onPtyData: (callback) => {
    ipcRenderer.on('pty:data', (event, data) => callback(data));
  },
  onPtyExit: (callback) => {
    ipcRenderer.on('pty:exit', (event, code) => callback(code));
  },

  // ── Window controls (custom titlebar) ──
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximize: () => ipcRenderer.send('window:maximize'),
  windowClose: () => ipcRenderer.send('window:close'),

  // ── Menu events (main → renderer) ──
  onMenuSave: (callback) => ipcRenderer.on('menu:save', callback),
  onMenuSaveAs: (callback) => ipcRenderer.on('menu:save-as', callback),
  onMenuToggleSidebar: (callback) => ipcRenderer.on('menu:toggle-sidebar', callback),
  onMenuToggleTerminal: (callback) => ipcRenderer.on('menu:toggle-terminal', callback),
  onMenuSwitchTheme: (callback) => {
    ipcRenderer.on('menu:switch-theme', (event, theme) => callback(theme));
  },
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
  gitGraphLog: (cwd, limit) => ipcRenderer.invoke('git:graphLog', cwd, limit),

  // ── LSP (Language Server Protocol) ──
  lspStart: (workspaceFolder) => ipcRenderer.invoke('lsp:start', workspaceFolder),
  lspStop: () => ipcRenderer.invoke('lsp:stop'),
  lspRequest: (method, params) => ipcRenderer.invoke('lsp:request', method, params),
  lspNotify: (method, params) => ipcRenderer.send('lsp:notify', method, params),
  onLspNotification: (callback) => {
    ipcRenderer.on('lsp:notification', (event, message) => callback(message));
  },

  // ── Utilidades ──
  platform: process.platform, // 'win32', 'darwin', 'linux'
  getFileIcon: (filename) => getIcon(filename).svg,
  syncTheme: (theme) => ipcRenderer.send('theme:sync', theme),
  getMemoryUsage: () => process.memoryUsage(),
  getCpuUsage: () => ipcRenderer.invoke('system:cpuUsage'),
});
