/**
 * ══════════════════════════════════════════════════════════════
 * MAIN PROCESS (main.js)
 * ══════════════════════════════════════════════════════════════
 *
 * Este es el "backend" de la app Electron. Corre en Node.js y se
 * encarga de:
 *
 * 1. Crear la ventana del browser (BrowserWindow)
 * 2. Manejar el menú nativo del SO
 * 3. Escuchar mensajes IPC del renderer (frontend)
 * 4. Acceder al filesystem (fs) y procesos del SO (child_process)
 * 5. Spawning de la pseudo-terminal (node-pty) para xterm.js
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
const { execFile } = require('child_process');

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

// ────────────────────────────────────────────
// 1. VENTANA PRINCIPAL — BrowserWindow con custom titlebar
//    Configura frame, preload, seguridad y DevTools
// ────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    // Sacamos el frame nativo para tener custom titlebar
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d1a2a',
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
//    File, Edit, View, Terminal, Tema, Help
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
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About MojaveCode PHP',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'MojaveCode PHP',
              message: 'MojaveCode PHP v0.1.0',
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
      .filter((entry) => !entry.name.startsWith('.')) // Ocultar dotfiles
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
  const MAX_FILES = 5000;
  const MAX_DEPTH = 15;
  const ignore = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__']);

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
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignore.has(entry.name)) await walk(fullPath, depth + 1);
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
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true, error: null };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

// ────────────────────────────────────────────
// 4. IPC HANDLERS — DIÁLOGOS NATIVOS DEL SO
//    Open Folder, Open File, Save As
// ────────────────────────────────────────────
async function handleOpenFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (!result.canceled && result.filePaths[0]) {
    mainWindow.webContents.send('folder:opened', result.filePaths[0]);
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
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
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

  const result = await runGit(['status', '--porcelain=v1', '-uall'], cwd);
  if (result.error) return result;

  const files = { staged: [], unstaged: [], untracked: [], repoRoot };
  if (!result.output) return { files };

  for (const line of result.output.split('\n')) {
    if (!line || line.length < 3) continue;
    const x = line[0]; // index status
    const y = line[1]; // worktree status
    // El path empieza en posición 3 (XY + espacio)
    let filePath = line.substring(3);

    // Manejar renamed: "old -> new"
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop();
    }

    // Quitar comillas si git las agrega
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    // Construir path absoluto
    const absolutePath = path.join(repoRoot, filePath);

    if (x === '?' && y === '?') {
      files.untracked.push({ path: filePath, absolutePath, status: 'untracked' });
    } else {
      // Staged changes (index)
      if (x !== ' ' && x !== '?') {
        const statusMap = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
        files.staged.push({ path: filePath, absolutePath, status: statusMap[x] || x });
      }
      // Unstaged changes (worktree)
      if (y !== ' ' && y !== '?') {
        const statusMap = { M: 'modified', D: 'deleted' };
        files.unstaged.push({ path: filePath, absolutePath, status: statusMap[y] || y });
      }
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
  temaMenu.submenu.items.forEach((item) => {
    if (item.label === 'Mojave Dark') item.checked = themeName === 'dark';
    if (item.label === 'Mojave Light') item.checked = themeName === 'light';
  });
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
// 10. IPC HANDLERS — WINDOW CONTROLS (custom titlebar)
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
// 11. APP LIFECYCLE — Inicio, activación y cierre de Electron
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
