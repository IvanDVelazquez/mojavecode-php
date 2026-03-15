/**
 * ══════════════════════════════════════════════════════════════
 * RENDERER PROCESS (renderer.js)
 * ══════════════════════════════════════════════════════════════
 *
 * Este es el "frontend" de la app. Corre dentro de Chromium y
 * tiene acceso al DOM. Maneja:
 *
 * 1. Monaco Editor — el motor de edición de código (el de VS Code)
 * 2. xterm.js — emulador de terminal en el browser
 * 3. File Tree — explorador de archivos con outline
 * 4. Tab Manager — pestañas abiertas (archivos, terminal, git graph, diff, output, db, routes)
 * 5. Git Panel — stage, unstage, commit, push, pull
 * 6. Search Panel — búsqueda de texto/regex en archivos del proyecto
 * 7. Symbol Search — búsqueda fuzzy de clases/funciones/métodos
 * 8. Composer/Artisan — ejecución de comandos desde el menú nativo
 * 9. PHP Tools — format on save, PHPUnit runner
 * 10. Database Viewer — conexión a MySQL/PostgreSQL con queries inline
 * 11. Route List — panel formateado de rutas Laravel
 *
 * Se comunica con el main process via window.api (expuesto por
 * preload.js). Nunca accede a fs o child_process directamente.
 *
 * DEPENDENCIAS:
 * - monaco-editor: ya cargado via AMD loader en index.html
 *   → disponible como global `monaco`
 * - @xterm/xterm: se importa vía require() del AMD loader
 * - window.api: bridge al main process (preload.js)
 * ══════════════════════════════════════════════════════════════
 */

// ┌──────────────────────────────────────────────────┐
// │  ESTADO GLOBAL DE LA APP                         │
// │  Objeto centralizado con el estado mutable:      │
// │  carpeta abierta, tabs, editor, terminal, y      │
// │  configuración de UI (sidebar, tema, git).       │
// └──────────────────────────────────────────────────┘
const state = {
  currentFolder: null,        // Path de la carpeta abierta
  openTabs: [],               // Array de { path, name, model, modified }
  activeTab: null,             // Tab actualmente visible
  sidebarVisible: true,
  sidebarView: 'explorer',   // 'explorer' | 'git' | 'search'
  gitRefreshTimer: null,
  editor: null,                // Instancia de Monaco
  terminal: null,              // Instancia de xterm.js
  terminalFitAddon: null,
  terminalResizeObserver: null, // ResizeObserver del terminal container
  formatOnSave: false,         // PHP format on save (desactivado por defecto)
};

// ┌──────────────────────────────────────────────────┐
// │  1. EDITOR                                       │
// │  Inicialización de Monaco, themes (dark/light),  │
// │  keybindings (save, quick open, close tab),      │
// │  y listeners de cursor/contenido.                │
// └──────────────────────────────────────────────────┘
function initEditor() {
  // Definir themes de Monaco
  monaco.editor.defineTheme('mojavecode-php-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6B87A8', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'EA6E40', fontStyle: 'bold' },
      { token: 'string', foreground: 'F1D7BA' },
      { token: 'number', foreground: 'F7A73E' },
      { token: 'type', foreground: 'F5A540' },
      { token: 'function', foreground: '2dd4bf' },
      { token: 'variable', foreground: 'F4E2CE' },
      { token: 'tag', foreground: '3fb950' },
      { token: 'attribute.name', foreground: '247D9D' },
      { token: 'attribute.value', foreground: 'F1D7BA' },
    ],
    colors: {
      'editor.background': '#152a4a',
      'editor.foreground': '#F4E2CE',
      'editor.lineHighlightBackground': '#1b3358',
      'editor.selectionBackground': '#264769',
      'editorCursor.foreground': '#E85324',
      'editorLineNumber.foreground': '#6B87A8',
      'editorLineNumber.activeForeground': '#F4E2CE',
      'editor.inactiveSelectionBackground': '#204366',
      'editorIndentGuide.background': '#264769',
      'editorIndentGuide.activeBackground': '#2E4D6D',
      'editorBracketMatch.border': '#E85324',
      'editorBracketMatch.background': '#E8532420',
      'minimap.background': '#112240',
      'scrollbarSlider.background': '#26476980',
      'scrollbarSlider.hoverBackground': '#2E4D6D80',
    },
  });

  monaco.editor.defineTheme('mojavecode-php-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6B87A8', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'D44A20', fontStyle: 'bold' },
      { token: 'string', foreground: '1a8a72' },
      { token: 'number', foreground: 'c88520' },
      { token: 'type', foreground: 'E85324' },
      { token: 'function', foreground: '247D9D' },
      { token: 'variable', foreground: '1F4266' },
      { token: 'tag', foreground: '2d8a3e' },
      { token: 'attribute.name', foreground: '247D9D' },
      { token: 'attribute.value', foreground: '1a8a72' },
    ],
    colors: {
      'editor.background': '#FFFFFF',
      'editor.foreground': '#1F4266',
      'editor.lineHighlightBackground': '#F4E2CE40',
      'editor.selectionBackground': '#E4896A30',
      'editorCursor.foreground': '#E85324',
      'editorLineNumber.foreground': '#6B87A8',
      'editorLineNumber.activeForeground': '#1F4266',
      'editor.inactiveSelectionBackground': '#F1D7BA30',
      'editorIndentGuide.background': '#E4896A20',
      'editorIndentGuide.activeBackground': '#E4896A40',
      'editorBracketMatch.border': '#E85324',
      'editorBracketMatch.background': '#E8532415',
      'minimap.background': '#FEFAF7',
      'scrollbarSlider.background': '#C4A88240',
      'scrollbarSlider.hoverBackground': '#C4A88260',
    },
  });

  // Crear la instancia del editor
  state.editor = monaco.editor.create(
    document.getElementById('editor-container'),
    {
      theme: 'mojavecode-php-dark',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 14,
      lineHeight: 22,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { indentation: true },
      padding: { top: 8 },
      automaticLayout: true, // Se auto-resizea con el container
      tabSize: 2,
      wordWrap: 'off',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
    }
  );

  // Escuchar cambios de posición del cursor → actualizar status bar
  state.editor.onDidChangeCursorPosition((e) => {
    document.getElementById('status-cursor').textContent =
      `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });

  // Escuchar cambios en el contenido → marcar tab como modified + actualizar outline
  let outlineTimer = null;
  state.editor.onDidChangeModelContent(() => {
    if (state.activeTab && !state.activeTab.modified) {
      state.activeTab.modified = true;
      renderTabs();
    }
    // Debounce outline update
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(updateOutline, 500);
  });

  // Keybinding: Ctrl+S → guardar archivo
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    () => saveCurrentFile()
  );

  // Keybinding: Cmd+P → Quick Open (interceptar antes que Monaco)
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP,
    () => toggleQuickOpen()
  );

  // Keybinding: Cmd+W → cerrar tab activo
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
    () => { if (state.activeTab) closeTab(state.activeTab.path); }
  );

  // Cmd+H: Find & Replace (Monaco built-in, just needs the trigger)
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
    () => state.editor.getAction('editor.action.startFindReplaceAction').run()
  );

  // Mostrar welcome screen (el editor se oculta hasta abrir un archivo)
  document.getElementById('welcome').style.display = 'flex';
}

// ┌──────────────────────────────────────────────────┐
// │  2. TERMINAL                                     │
// │  Emulador xterm.js conectado a un pty real       │
// │  (node-pty) via IPC. Incluye FitAddon para       │
// │  auto-resize, WebLinksAddon para URLs, y manejo  │
// │  bidireccional de datos (input/output).           │
// └──────────────────────────────────────────────────┘
async function initTerminal() {
  // xterm y addons se cargan como scripts globales desde index.html
  // (antes del AMD loader de Monaco para evitar conflictos)
  const Terminal = globalThis.Terminal;
  const FitAddon = window.FitAddon?.FitAddon;
  const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon;

  // Crear la terminal
  state.terminal = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    lineHeight: 1.5,
    theme: {
      background: '#0a1420',
      foreground: '#F4E2CE',
      cursor: '#E85324',
      cursorAccent: '#0a1420',
      selectionBackground: '#26476980',
      black: '#0d1a2a',
      red: '#EA6E40',
      green: '#3fb950',
      yellow: '#F7A73E',
      blue: '#247D9D',
      magenta: '#C4A882',
      cyan: '#2dd4bf',
      white: '#F4E2CE',
      brightBlack: '#6B87A8',
      brightRed: '#F5663C',
      brightGreen: '#3fb950',
      brightYellow: '#F5B25C',
      brightBlue: '#2dd4bf',
      brightMagenta: '#F1D7BA',
      brightCyan: '#2dd4bf',
      brightWhite: '#FEFAF7',
    },
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
  });

  // Addons: FitAddon ajusta cols/rows al tamaño del container
  if (FitAddon) {
    state.terminalFitAddon = new FitAddon();
    state.terminal.loadAddon(state.terminalFitAddon);
  }

  // WebLinksAddon: hace clickeables los URLs en la terminal
  if (WebLinksAddon) {
    state.terminal.loadAddon(new WebLinksAddon());
  }

  // Montar en el DOM
  state.terminal.open(document.getElementById('terminal-container'));

  // Fit al container
  if (state.terminalFitAddon) {
    setTimeout(() => state.terminalFitAddon.fit(), 100);
  }

  // Conectar al pty del main process
  const cwd = state.currentFolder || undefined;
  const result = await window.api.ptySpawn(cwd);

  if (result.error) {
    state.terminal.writeln(`\x1b[31mTerminal error: ${result.error}\x1b[0m`);
    state.terminal.writeln('Install node-pty: npm rebuild node-pty');
    return;
  }

  // pty → xterm (output)
  window.api.onPtyData((data) => {
    state.terminal.write(data);
  });

  // xterm → pty (input del usuario)
  state.terminal.onData((data) => {
    window.api.ptyWrite(data);
  });

  // Cuando el pty se cierra
  window.api.onPtyExit((code) => {
    state.terminal.writeln(`\r\n\x1b[33mProcess exited with code ${code}\x1b[0m`);
  });

  // Resize: cuando el container cambia de tamaño, ajustamos xterm y el pty
  // Guardar referencia para poder desconectar si se destruye la terminal
  if (state.terminalResizeObserver) {
    state.terminalResizeObserver.disconnect();
  }
  state.terminalResizeObserver = new ResizeObserver(() => {
    if (state.terminalFitAddon) {
      state.terminalFitAddon.fit();
      window.api.ptyResize(state.terminal.cols, state.terminal.rows);
    }
  });
  state.terminalResizeObserver.observe(document.getElementById('terminal-container'));
}

// ┌──────────────────────────────────────────────────┐
// │  3. FILE TREE                                    │
// │  Explorador de archivos con lazy-loading: solo   │
// │  carga el contenido de una carpeta al expandir.  │
// │  Maneja apertura de carpetas, renderizado del    │
// │  árbol, iconos, y navegación al editor.          │
// └──────────────────────────────────────────────────┘
async function loadFileTree(folderPath) {
  state.currentFolder = folderPath;
  quickOpen.allFiles = []; // Invalidar cache de Quick Open
  symbolSearch.allSymbols = []; // Invalidar cache de Symbol Search

  // Cerrar todos los tabs abiertos
  closeAllTabs();

  // Reiniciar terminal con el nuevo cwd
  resetTerminal(folderPath);

  const treeEl = document.getElementById('file-tree');
  const emptyEl = document.getElementById('file-tree-empty');
  if (emptyEl) emptyEl.style.display = 'none';
  treeEl.innerHTML = '';

  // Actualizar el título
  const folderName = folderPath.split(/[/\\]/).pop();
  document.getElementById('sidebar-header').querySelector('span').textContent =
    folderName.toUpperCase();
  document.getElementById('titlebar-title').textContent =
    `${folderName} — MojaveCode PHP`;

  // Renderizar la raíz
  await renderTreeLevel(folderPath, treeEl, 0);

  // Actualizar branch en el status bar
  window.api.gitBranch(folderPath).then((result) => {
    if (!result.error) {
      document.getElementById('status-branch').textContent = `⎇ ${result.output}`;
    }
  });

  // Iniciar LSP para esta carpeta
  if (typeof startLsp === 'function') {
    startLsp(folderPath);
  }

  // Detectar Composer/Artisan/Modules
  window.api.detectProject(folderPath);
}

async function renderTreeLevel(dirPath, parentEl, depth) {
  const entries = await window.api.readDir(dirPath);

  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.style.paddingLeft = `${12 + depth * 16}px`;
    item.dataset.path = entry.path;

    if (entry.isDirectory) {
      item.innerHTML = `
        <span class="tree-chevron">▸</span>
        <span class="tree-icon folder-icon">${getFolderIcon()}</span>
        <span class="tree-name">${escapeHtml(entry.name)}</span>`;

      let expanded = false;
      let childContainer = null;

      item.addEventListener('click', async () => {
        if (!expanded) {
          // Lazy load: cargar hijos al expandir
          childContainer = document.createElement('div');
          childContainer.className = 'tree-children';
          item.after(childContainer);
          await renderTreeLevel(entry.path, childContainer, depth + 1);
          item.querySelector('.tree-chevron').textContent = '▾';
          expanded = true;
        } else {
          // Colapsar: remover hijos
          childContainer?.remove();
          childContainer = null;
          item.querySelector('.tree-chevron').textContent = '▸';
          expanded = false;
        }
      });
    } else {
      // Archivo — click lo abre en el editor
      const fileIconSvg = window.api.getFileIcon(entry.name);
      item.innerHTML = `
        <span class="tree-chevron" style="visibility:hidden">▸</span>
        <span class="tree-icon">${fileIconSvg}</span>
        <span class="tree-name">${escapeHtml(entry.name)}</span>`;

      item.addEventListener('click', () => openFile(entry.path, entry.name));
    }

    parentEl.appendChild(item);
  }
}

function getFolderIcon() {
  return '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="#F7A73E"/></svg>';
}

// ┌──────────────────────────────────────────────────┐
// │  4. TAB MANAGER                                  │
// │  Gestión de pestañas: abrir, cerrar, activar,    │
// │  y renderizar. Cada tab tiene un Monaco          │
// │  TextModel que preserva undo/redo, cursor, y     │
// │  scroll. Incluye warnings de cambios sin guardar.│
// └──────────────────────────────────────────────────┘
async function openFile(filePath, fileName) {
  // ¿Ya está abierto? → activar ese tab
  const existing = state.openTabs.find((t) => t.path === filePath);
  if (existing) {
    activateTab(existing);
    return;
  }

  // Leer el archivo del disco via IPC
  const result = await window.api.readFile(filePath);
  if (result.error) {
    console.error('Error reading file:', result.error);
    return;
  }

  // Detectar el lenguaje por la extensión
  const ext = filePath.split('.').pop();
  const language = getMonacoLanguage(ext);

  // Crear un Monaco TextModel para este archivo
  // Cada archivo tiene su propio model — preserva undo history, etc
  const uri = monaco.Uri.file(filePath);
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(result.content, language, uri);
  }

  const tab = {
    path: filePath,
    name: fileName || filePath.split(/[/\\]/).pop(),
    model,
    language,
    modified: false,
  };

  state.openTabs.push(tab);
  activateTab(tab);

  // Notificar al LSP si es un archivo PHP
  if (typeof lspTrackModel === 'function') {
    lspTrackModel(model, language);
  }

  // Auto-namespace: si es un .php vacío, generar boilerplate
  if (language === 'php' && (!result.content || result.content.trim() === '')) {
    generatePhpBoilerplate(filePath, model, tab);
  }
}

async function generatePhpBoilerplate(filePath, model, tab) {
  const result = await window.api.phpResolvePsr4(filePath);
  if (!result || !result.namespace) return;

  const className = result.className;
  const namespace = result.namespace;

  const boilerplate = `<?php

namespace ${namespace};

class ${className}
{
    //
}
`;

  model.setValue(boilerplate);
  tab.modified = true;
  renderTabs();

  // Posicionar cursor en la línea del comentario dentro de la clase
  if (state.editor) {
    const lineCount = model.getLineCount();
    state.editor.setPosition({ lineNumber: lineCount - 1, column: 5 });
    state.editor.focus();
  }
}

function activateTab(tab) {
  state.activeTab = tab;
  document.getElementById('welcome').style.display = 'none';

  const isTerminal = tab.path === '__terminal__';
  const isGitGraph = tab.path === '__git-graph__';
  const isDiff = tab.path.startsWith('__diff__');
  const isErrorLog = tab.path === '__errorlog__';
  const isCommandOutput = tab.path === '__command-output__';
  const isDbViewer = tab.path === '__db-viewer__';
  const isRouteList = tab.path === '__route-list__';

  // Mostrar solo el container correcto
  const isEditor = !isTerminal && !isGitGraph && !isDiff && !isErrorLog && !isCommandOutput && !isDbViewer && !isRouteList;
  document.getElementById('editor-container').style.display = isEditor ? 'block' : 'none';
  document.getElementById('terminal-container').style.display = isTerminal ? 'block' : 'none';
  document.getElementById('git-graph-container').style.display = isGitGraph ? 'block' : 'none';
  document.getElementById('diff-container').style.display = isDiff ? 'block' : 'none';
  document.getElementById('errorlog-container').style.display = isErrorLog ? 'flex' : 'none';
  document.getElementById('command-output-container').style.display = isCommandOutput ? 'block' : 'none';
  document.getElementById('db-viewer-container').style.display = isDbViewer ? 'flex' : 'none';
  document.getElementById('route-list-container').style.display = isRouteList ? 'flex' : 'none';

  if (isTerminal) {
    document.getElementById('status-language').textContent = 'Terminal';
    if (state.terminalFitAddon) {
      setTimeout(() => state.terminalFitAddon.fit(), 50);
    }
    state.terminal?.focus();
  } else if (isGitGraph) {
    document.getElementById('status-language').textContent = 'Git Graph';
  } else if (isDiff) {
    document.getElementById('status-language').textContent = 'Diff';
    if (tab.diffEditor) {
      setTimeout(() => tab.diffEditor.layout(), 50);
    } else if (tab.path.startsWith('__diff__')) {
      // Diff editor fue limpiado por otro diff — cerrar este tab obsoleto
      closeTab(tab.path);
      return;
    }
  } else if (isErrorLog) {
    document.getElementById('status-language').textContent = 'Error Log';
  } else if (isCommandOutput) {
    document.getElementById('status-language').textContent = 'Output';
  } else if (isDbViewer) {
    document.getElementById('status-language').textContent = 'Database';
  } else if (isRouteList) {
    document.getElementById('status-language').textContent = 'Routes';
  } else {
    state.editor.setModel(tab.model);
    document.getElementById('status-language').textContent =
      getLanguageDisplayName(tab.language);
    state.editor.focus();
  }

  // Highlight en file tree
  document.querySelectorAll('.tree-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === tab.path);
  });

  renderTabs();
  updateOutline();
}

function closeTab(tabPath) {
  const idx = state.openTabs.findIndex((t) => t.path === tabPath);
  if (idx === -1) return;

  const tab = state.openTabs[idx];

  // Warn if file has unsaved changes
  if (tab.modified && tab.model) {
    const save = confirm(`"${tab.name}" has unsaved changes. Close without saving?`);
    if (!save) return;
  }

  // Limpiar diff editor si aplica (dispose editor ANTES que los models)
  if (tab.diffEditor) {
    try { tab.diffEditor.dispose(); } catch { /* already disposed */ }
    if (tab.diffModels) {
      tab.diffModels.forEach((m) => { try { m.dispose(); } catch { /* ok */ } });
    }
    document.getElementById('diff-container').innerHTML = '';
  }

  // Notificar al LSP antes de destruir el model (proteger contra doble dispose)
  if (tab.path !== '__terminal__' && tab.path !== '__git-graph__' && tab.path !== '__errorlog__' && !tab.path.startsWith('__diff__') && tab.model) {
    if (typeof lspUntrackModel === 'function') {
      lspUntrackModel(tab.model);
    }
    try { tab.model.dispose(); } catch { /* ya dispuesto */ }
    tab.model = null;
  }

  state.openTabs.splice(idx, 1);

  if (state.activeTab?.path === tabPath) {
    // Activar el tab anterior/siguiente, o mostrar welcome
    const next = state.openTabs[idx < state.openTabs.length ? idx : idx - 1];
    if (next) {
      activateTab(next);
    } else {
      state.activeTab = null;
      document.getElementById('welcome').style.display = 'flex';
      document.getElementById('editor-container').style.display = 'none';
      document.getElementById('terminal-container').style.display = 'none';
      document.getElementById('git-graph-container').style.display = 'none';
      document.getElementById('diff-container').style.display = 'none';
      document.getElementById('errorlog-container').style.display = 'none';
      updateOutline();
    }
  }

  renderTabs();
}

function closeAllTabs() {
  const unsaved = state.openTabs.filter((t) => t.modified && t.model);
  if (unsaved.length > 0) {
    const close = confirm(`${unsaved.length} file(s) with unsaved changes. Close all without saving?`);
    if (!close) return;
  }

  // Disponer todos los models y diff editors (proteger contra doble dispose)
  for (const tab of state.openTabs) {
    if (tab.diffEditor) {
      if (tab.diffModels) tab.diffModels.forEach((m) => { try { m.dispose(); } catch {} });
      try { tab.diffEditor.dispose(); } catch {}
    }
    if (tab.model && tab.path !== '__terminal__' && tab.path !== '__git-graph__' && !tab.path.startsWith('__diff__')) {
      if (typeof lspUntrackModel === 'function') lspUntrackModel(tab.model);
      try { tab.model.dispose(); } catch {}
      tab.model = null;
    }
  }

  state.openTabs = [];
  state.activeTab = null;

  document.getElementById('diff-container').innerHTML = '';
  document.getElementById('git-graph-container').innerHTML = '';
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('editor-container').style.display = 'none';
  document.getElementById('terminal-container').style.display = 'none';
  document.getElementById('git-graph-container').style.display = 'none';
  document.getElementById('diff-container').style.display = 'none';

  renderTabs();
  updateOutline();
}

async function resetTerminal(cwd) {
  if (state.terminal) {
    state.terminal.clear();
    // Respawn pty con nuevo cwd
    await window.api.ptySpawn(cwd);
  }
}

function renderTabs() {
  const bar = document.getElementById('tab-bar');
  const existingEls = Array.from(bar.children);
  const tabCount = state.openTabs.length;

  // Eliminar tabs sobrantes del DOM
  while (existingEls.length > tabCount) {
    existingEls.pop().remove();
  }

  state.openTabs.forEach((tab, i) => {
    let el = existingEls[i];
    const isActive = state.activeTab === tab;
    const label = `${tab.modified ? '● ' : ''}${tab.name}`;

    if (!el) {
      // Crear nuevo tab si no existe en el DOM
      el = document.createElement('div');
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          closeTab(e.target.dataset.path);
        } else {
          const t = state.openTabs[i];
          if (t) activateTab(t);
        }
      });
      bar.appendChild(el);
    }

    // Actualizar solo si cambió
    el.className = `tab ${isActive ? 'active' : ''}`;
    const nameSpan = el.querySelector('.tab-name');
    if (!nameSpan || nameSpan.textContent !== label || el.querySelector('.tab-close')?.dataset.path !== tab.path) {
      el.innerHTML = `
        <span class="tab-name">${label}</span>
        <span class="tab-close" data-path="${tab.path}">✕</span>`;
    }
  });
}

// ┌──────────────────────────────────────────────────┐
// │  5. FILE SAVE                                    │
// │  Escribe el contenido del tab activo a disco     │
// │  via IPC, marca el tab como no-modificado, y     │
// │  notifica al LSP del guardado.                   │
// └──────────────────────────────────────────────────┘
async function saveCurrentFile() {
  if (!state.activeTab || !state.activeTab.model) return;

  const content = state.activeTab.model.getValue();
  const result = await window.api.writeFile(state.activeTab.path, content);

  if (result.success) {
    state.activeTab.modified = false;
    renderTabs();
    // Notificar al LSP del save
    if (typeof lspDidSave === 'function' && state.activeTab.model) {
      lspDidSave(state.activeTab.model.uri.toString(), content);
    }

    // Format on save para archivos PHP
    if (state.formatOnSave && state.activeTab.language === 'php') {
      const formatResult = await window.api.phpFormat(state.activeTab.path);
      if (formatResult && !formatResult.error) {
        // Re-leer el archivo formateado y actualizar el editor
        const updated = await window.api.readFile(state.activeTab.path);
        if (updated.content !== null && updated.content !== content) {
          const position = state.editor.getPosition();
          state.activeTab.model.setValue(updated.content);
          // Restaurar posición del cursor
          if (position) state.editor.setPosition(position);
          state.activeTab.modified = false;
          renderTabs();
        }
      }
    }
  } else {
    console.error('Save error:', result.error);
  }
}

// ┌──────────────────────────────────────────────────┐
// │  6. LANGUAGE DETECTION                           │
// │  Mapeo de extensiones de archivo a language IDs  │
// │  de Monaco y nombres legibles para el status     │
// │  bar. Cubre 30+ extensiones comunes.             │
// └──────────────────────────────────────────────────┘
function getMonacoLanguage(ext) {
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', json5: 'json',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', mdx: 'markdown',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c', cpp: 'cpp', h: 'c',
    cs: 'csharp',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yml: 'yaml', yaml: 'yaml',
    xml: 'xml', svg: 'xml',
    vue: 'html',
    dockerfile: 'dockerfile',
    env: 'plaintext',
    gitignore: 'plaintext',
    txt: 'plaintext',
  };
  return map[ext?.toLowerCase()] || 'plaintext';
}

function getLanguageDisplayName(langId) {
  const names = {
    javascript: 'JavaScript', typescript: 'TypeScript',
    json: 'JSON', html: 'HTML', css: 'CSS',
    scss: 'SCSS', less: 'Less', markdown: 'Markdown',
    php: 'PHP', python: 'Python', ruby: 'Ruby',
    rust: 'Rust', go: 'Go', java: 'Java',
    c: 'C', cpp: 'C++', csharp: 'C#',
    sql: 'SQL', shell: 'Shell', yaml: 'YAML',
    xml: 'XML', dockerfile: 'Dockerfile',
    plaintext: 'Plain Text',
  };
  return names[langId] || langId;
}

// ┌──────────────────────────────────────────────────┐
// │  7. UI TOGGLES & RESIZER                         │
// │  Funciones para mostrar/ocultar sidebar y        │
// │  terminal. La terminal se abre como un tab       │
// │  más, integrada con el tab manager.              │
// └──────────────────────────────────────────────────┘
function toggleSidebar() {
  state.sidebarVisible = !state.sidebarVisible;
  document.getElementById('sidebar').classList.toggle('hidden', !state.sidebarVisible);
}

function toggleTerminal() {
  const existing = state.openTabs.find((t) => t.path === '__terminal__');
  if (existing) {
    // Si ya está abierto y es el activo, cerrarlo; si no, activarlo
    if (state.activeTab === existing) {
      closeTab('__terminal__');
    } else {
      activateTab(existing);
    }
  } else {
    // Abrir como tab nuevo
    const tab = {
      path: '__terminal__',
      name: 'Terminal',
      model: null,
      language: 'terminal',
      modified: false,
    };
    state.openTabs.push(tab);
    activateTab(tab);
  }
}

// ┌──────────────────────────────────────────────────┐
// │  7b. DIFF VIEW                                   │
// │  Vista side-by-side de cambios git usando el     │
// │  DiffEditor de Monaco. Soporta staged y          │
// │  unstaged, comparando HEAD vs index/disco.       │
// └──────────────────────────────────────────────────┘
async function openDiffView(relativePath, absolutePath, fileName, staged) {
  const diffId = `__diff__${staged ? 'staged' : 'unstaged'}__${relativePath}`;

  // Si ya está abierto, activar
  const existing = state.openTabs.find((t) => t.path === diffId);
  if (existing) {
    activateTab(existing);
    return;
  }

  // Obtener contenido original (HEAD para unstaged, HEAD para staged)
  const originalResult = await window.api.gitShow(state.currentFolder, relativePath, 'HEAD');
  const originalContent = originalResult.error ? '' : originalResult.output;

  // Obtener contenido modificado
  let modifiedContent = '';
  if (staged) {
    // Para staged: el contenido está en el index
    const indexResult = await window.api.gitShow(state.currentFolder, relativePath, '');
    modifiedContent = indexResult.error ? '' : indexResult.output;
  } else {
    // Para unstaged: leer del disco
    const fileResult = await window.api.readFile(absolutePath);
    modifiedContent = fileResult.error ? '' : fileResult.content;
  }

  const ext = fileName.split('.').pop();
  const language = getMonacoLanguage(ext);

  // Limpiar diff editor anterior si existe (otro tab diff abierto)
  const prevDiff = state.openTabs.find((t) => t.path.startsWith('__diff__') && t.diffEditor);
  if (prevDiff) {
    try { prevDiff.diffEditor.dispose(); } catch { /* ok */ }
    if (prevDiff.diffModels) {
      prevDiff.diffModels.forEach((m) => { try { m.dispose(); } catch { /* ok */ } });
    }
    prevDiff.diffEditor = null;
    prevDiff.diffModels = null;
  }

  const container = document.getElementById('diff-container');
  container.innerHTML = '';

  const diffEditor = monaco.editor.createDiffEditor(container, {
    theme: document.documentElement.getAttribute('data-theme') === 'light'
      ? 'mojavecode-php-light' : 'mojavecode-php-dark',
    readOnly: true,
    automaticLayout: true,
    renderSideBySide: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 14,
    lineHeight: 22,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
  });

  const originalModel = monaco.editor.createModel(originalContent, language);
  const modifiedModel = monaco.editor.createModel(modifiedContent, language);

  diffEditor.setModel({
    original: originalModel,
    modified: modifiedModel,
  });

  const label = staged ? 'Staged' : 'Changes';
  const tab = {
    path: diffId,
    name: `${fileName} (${label})`,
    model: null,
    language,
    modified: false,
    diffEditor,
    diffModels: [originalModel, modifiedModel],
  };

  state.openTabs.push(tab);
  activateTab(tab);
}

// ┌──────────────────────────────────────────────────┐
// │  7c. GIT GRAPH TAB                               │
// │  Visualización del historial de commits como     │
// │  grafo SVG con lanes, colores por rama, badges   │
// │  de refs/tags, y scroll sobre hasta 150 commits. │
// └──────────────────────────────────────────────────┘
function openGitGraph() {
  const existing = state.openTabs.find((t) => t.path === '__git-graph__');
  if (existing) {
    activateTab(existing);
    loadGitGraph(); // refrescar
    return;
  }

  const tab = {
    path: '__git-graph__',
    name: 'Git Graph',
    model: null,
    language: 'git-graph',
    modified: false,
  };
  state.openTabs.push(tab);
  activateTab(tab);
  loadGitGraph();
}

async function loadGitGraph() {
  const container = document.getElementById('git-graph-container');
  if (!state.currentFolder) {
    container.innerHTML = '<div class="gg-empty">Open a folder to view the git graph</div>';
    return;
  }

  container.innerHTML = '<div class="gg-loading">Loading git graph...</div>';

  const result = await window.api.gitGraphLog(state.currentFolder, 150);
  if (result.error) {
    container.innerHTML = `<div class="gg-empty">Error: ${result.error}</div>`;
    return;
  }

  const commits = result.commits || [];
  if (!commits.length) {
    container.innerHTML = '<div class="gg-empty">No commits found</div>';
    return;
  }

  renderGitGraph(container, commits);
}

function renderGitGraph(container, commits) {
  // Asignar columnas (lanes) a cada commit basado en sus ramas
  const hashToIdx = new Map();
  commits.forEach((c, i) => hashToIdx.set(c.hash, i));

  // Colores para las lanes
  const laneColors = [
    'var(--accent-green)', 'var(--accent-blue)', 'var(--accent-yellow)',
    'var(--accent-red)', 'var(--accent-teal)', '#c678dd', '#e06c75',
    '#61afef', '#d19a66', '#56b6c2',
  ];

  // Asignar lanes: cada commit "vivo" ocupa una columna
  const activeLanes = []; // array de hash que ocupa cada lane
  const commitLane = new Map();
  const laneConnections = []; // info para dibujar las líneas

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];

    // Buscar si este commit ya tiene lane asignada (por un hijo)
    let lane = activeLanes.indexOf(c.hash);
    if (lane === -1) {
      // Nuevo branch — buscar lane libre
      lane = activeLanes.indexOf(null);
      if (lane === -1) {
        lane = activeLanes.length;
        activeLanes.push(null);
      }
    }

    commitLane.set(c.hash, lane);
    activeLanes[lane] = null; // liberar

    // Primer padre continúa en la misma lane
    if (c.parents.length > 0) {
      activeLanes[lane] = c.parents[0];
    }

    // Padres adicionales (merges) — asignar lanes extra
    for (let p = 1; p < c.parents.length; p++) {
      const parentHash = c.parents[p];
      let parentLane = activeLanes.indexOf(parentHash);
      if (parentLane === -1) {
        parentLane = activeLanes.indexOf(null);
        if (parentLane === -1) {
          parentLane = activeLanes.length;
          activeLanes.push(null);
        }
        activeLanes[parentLane] = parentHash;
      }
      laneConnections.push({ fromRow: i, fromLane: lane, toLane: parentLane, type: 'merge' });
    }

    // Limpiar lanes vacías al final
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
  }

  const maxLanes = Math.max(...Array.from(commitLane.values())) + 1;
  const ROW_H = 32;
  const LANE_W = 16;
  const GRAPH_W = maxLanes * LANE_W + 20;
  const NODE_R = 4;

  // Construir SVG para las líneas y nodos
  const svgH = commits.length * ROW_H;
  let svgContent = '';

  // Dibujar conexiones padre-hijo
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const lane = commitLane.get(c.hash);
    const cx = lane * LANE_W + 10;
    const cy = i * ROW_H + ROW_H / 2;
    const color = laneColors[lane % laneColors.length];

    for (const parentHash of c.parents) {
      const parentIdx = hashToIdx.get(parentHash);
      if (parentIdx === undefined) continue;

      const parentLane = commitLane.get(parentHash);
      const px = parentLane * LANE_W + 10;
      const py = parentIdx * ROW_H + ROW_H / 2;
      const pColor = laneColors[parentLane % laneColors.length];
      const lineColor = parentLane === lane ? color : pColor;

      if (parentLane === lane) {
        // Línea recta vertical
        svgContent += `<line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="${lineColor}" stroke-width="2" stroke-opacity="0.7"/>`;
      } else {
        // Curva para merge/branch
        const midY = cy + (py - cy) * 0.4;
        svgContent += `<path d="M${cx},${cy} C${cx},${midY} ${px},${midY} ${px},${py}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-opacity="0.7"/>`;
      }
    }
  }

  // Dibujar nodos encima de las líneas
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const lane = commitLane.get(c.hash);
    const cx = lane * LANE_W + 10;
    const cy = i * ROW_H + ROW_H / 2;
    const color = laneColors[lane % laneColors.length];

    const isMerge = c.parents.length > 1;
    if (isMerge) {
      svgContent += `<circle cx="${cx}" cy="${cy}" r="${NODE_R + 1}" fill="var(--bg-dark)" stroke="${color}" stroke-width="2"/>`;
    } else {
      svgContent += `<circle cx="${cx}" cy="${cy}" r="${NODE_R}" fill="${color}"/>`;
    }
  }

  // Construir filas de texto
  let rowsHTML = '';
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const lane = commitLane.get(c.hash);
    const color = laneColors[lane % laneColors.length];

    // Badges de refs (branches, tags, HEAD)
    let refsHTML = '';
    for (const ref of c.refs) {
      let cls = 'gg-ref';
      if (ref.startsWith('HEAD')) cls += ' gg-ref-head';
      else if (ref.startsWith('tag:')) cls += ' gg-ref-tag';
      else cls += ' gg-ref-branch';
      const label = ref.replace('tag: ', '');
      refsHTML += `<span class="${cls}">${label}</span>`;
    }

    const escapedMsg = c.message
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    rowsHTML += `<div class="gg-row" style="height:${ROW_H}px">
      <div class="gg-graph-cell" style="width:${GRAPH_W}px"></div>
      <div class="gg-info">
        <span class="gg-hash" style="color:${color}">${c.shortHash}</span>
        ${refsHTML}
        <span class="gg-message">${escapedMsg}</span>
      </div>
      <span class="gg-author">${c.author}</span>
      <span class="gg-date">${c.date}</span>
    </div>`;
  }

  container.innerHTML = `
    <div class="gg-wrapper">
      <div class="gg-scroll">
        <div class="gg-canvas" style="position:relative;">
          <svg class="gg-svg" width="${GRAPH_W}" height="${svgH}" style="position:absolute;top:0;left:0;">
            ${svgContent}
          </svg>
          <div class="gg-rows">
            ${rowsHTML}
          </div>
        </div>
      </div>
    </div>`;
}

// ┌──────────────────────────────────────────────────┐
// │  7e. SIDEBAR SECTIONS & OUTLINE                  │
// │  Panel lateral con secciones colapsables y       │
// │  outline de símbolos (funciones, clases, etc.)   │
// │  extraídos con regex por lenguaje.               │
// └──────────────────────────────────────────────────┘
function initSidebarSections() {
  document.querySelectorAll('.sidebar-section-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
      header.closest('.sidebar-section').classList.toggle('collapsed');
    });
  });
}

// Extraer símbolos (funciones, clases, métodos) del contenido de un archivo
function extractSymbols(content, language) {
  const symbols = [];
  const lines = content.split('\n');

  // Patrones por lenguaje
  const patterns = {
    php: [
      { regex: /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/,           kind: 'class' },
      { regex: /^\s*interface\s+(\w+)/,                                  kind: 'interface' },
      { regex: /^\s*trait\s+(\w+)/,                                      kind: 'class' },
      { regex: /^\s*(?:public|protected|private|static|\s)*function\s+(\w+)\s*\(/, kind: 'method' },
      { regex: /^\s*(?:public|protected|private|static)\s+(?:\?\w+\s+)?\$(\w+)/,  kind: 'property' },
      { regex: /^\s*const\s+(\w+)\s*=/,                                  kind: 'const' },
      { regex: /^\s*define\s*\(\s*['"](\w+)['"]/,                        kind: 'const' },
    ],
    javascript: [
      { regex: /^\s*class\s+(\w+)/,                                      kind: 'class' },
      { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,        kind: 'function' },
      { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,    kind: 'function' },
      { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: 'function' },
      { regex: /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,                kind: 'method' },
      { regex: /^\s*const\s+([A-Z_][A-Z0-9_]*)\s*=/,                     kind: 'const' },
      { regex: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*[^(]/,             kind: 'variable' },
      { regex: /^\s*(?:export\s+)?let\s+(\w+)\s*=/,                      kind: 'variable' },
    ],
    typescript: [
      { regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,        kind: 'class' },
      { regex: /^\s*(?:export\s+)?interface\s+(\w+)/,                     kind: 'interface' },
      { regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,        kind: 'function' },
      { regex: /^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,    kind: 'function' },
      { regex: /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,              kind: 'method' },
      { regex: /^\s*(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/,       kind: 'const' },
      { regex: /^\s*(?:export\s+)?const\s+(\w+)\s*[=:]\s*[^(]/,          kind: 'variable' },
      { regex: /^\s*(?:export\s+)?let\s+(\w+)\s*=/,                      kind: 'variable' },
    ],
    python: [
      { regex: /^\s*class\s+(\w+)/,                                      kind: 'class' },
      { regex: /^\s*(?:async\s+)?def\s+(\w+)/,                           kind: 'function' },
      { regex: /^([A-Z_][A-Z0-9_]*)\s*=/,                                kind: 'const' },
    ],
    java: [
      { regex: /^\s*(?:public|private|protected)?\s*(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
      { regex: /^\s*(?:public|private|protected)?\s*interface\s+(\w+)/,  kind: 'interface' },
      { regex: /^\s*(?:public|private|protected|static|\s)*\w+\s+(\w+)\s*\(/, kind: 'method' },
      { regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?\w+\s+(\w+)\s*[=;]/, kind: 'property' },
    ],
    go: [
      { regex: /^type\s+(\w+)\s+struct/,                                  kind: 'class' },
      { regex: /^type\s+(\w+)\s+interface/,                               kind: 'interface' },
      { regex: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/,            kind: 'function' },
      { regex: /^(?:var|const)\s+(\w+)\s*/,                               kind: 'const' },
    ],
    ruby: [
      { regex: /^\s*class\s+(\w+)/,                                      kind: 'class' },
      { regex: /^\s*module\s+(\w+)/,                                     kind: 'class' },
      { regex: /^\s*def\s+(\w+)/,                                        kind: 'method' },
      { regex: /^\s*([A-Z_][A-Z0-9_]*)\s*=/,                             kind: 'const' },
    ],
    rust: [
      { regex: /^\s*(?:pub\s+)?struct\s+(\w+)/,                          kind: 'class' },
      { regex: /^\s*(?:pub\s+)?trait\s+(\w+)/,                           kind: 'interface' },
      { regex: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,                 kind: 'function' },
      { regex: /^\s*impl\s+(\w+)/,                                       kind: 'class' },
      { regex: /^\s*(?:pub\s+)?(?:static|const)\s+(\w+)/,                kind: 'const' },
    ],
    css: [
      { regex: /^([.#][\w-]+(?:\s*[,>+~]\s*[.#]?[\w-]+)*)\s*\{/,        kind: 'class' },
      { regex: /^\s*(--[\w-]+)\s*:/,                                      kind: 'variable' },
    ],
  };

  // Mapear lenguaje de Monaco a nuestros patrones
  const langMap = {
    php: 'php', javascript: 'javascript', typescript: 'typescript',
    typescriptreact: 'typescript', javascriptreact: 'javascript',
    python: 'python', java: 'java', go: 'go', ruby: 'ruby',
    rust: 'rust', css: 'css', scss: 'css', less: 'css',
  };

  const langPatterns = patterns[langMap[language]] || patterns.javascript;
  let currentClass = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, kind } of langPatterns) {
      const match = line.match(regex);
      if (match) {
        // Evitar falsos positivos comunes
        const name = match[1];
        if (!name || name === 'if' || name === 'for' || name === 'while' ||
            name === 'switch' || name === 'catch' || name === 'return' ||
            name === 'new' || name === 'else' || name === 'try') continue;

        const isClassLevel = kind === 'class' || kind === 'interface';
        const depth = isClassLevel ? 0 : (currentClass ? 1 : 0);

        if (isClassLevel) currentClass = name;

        symbols.push({
          name,
          kind,
          line: i + 1,
          depth,
        });
        break;
      }
    }
  }

  return symbols;
}

function updateOutline() {
  const listEl = document.getElementById('outline-list');

  if (!state.activeTab || !state.activeTab.model || state.activeTab.path.startsWith('__')) {
    listEl.innerHTML = '<div id="outline-empty">No file open</div>';
    return;
  }

  const content = state.activeTab.model.getValue();
  const language = state.activeTab.language;
  const symbols = extractSymbols(content, language);

  if (!symbols.length) {
    listEl.innerHTML = '<div id="outline-empty">No symbols found</div>';
    return;
  }

  const iconLabel = { class: 'C', interface: 'I', function: 'ƒ', method: 'm', property: 'p', const: 'c', variable: 'v' };

  // Agrupar por categoría (constantes y properties antes de métodos)
  const groupOrder = ['class', 'interface', 'const', 'property', 'variable', 'function', 'method'];
  const groupLabels = {
    class: 'Classes', interface: 'Interfaces', function: 'Functions',
    method: 'Methods', property: 'Properties', const: 'Constants', variable: 'Variables',
  };

  const groups = {};
  for (const s of symbols) {
    const g = groups[s.kind] || (groups[s.kind] = []);
    g.push(s);
  }

  // Categorías que van en carpeta (colapsables)
  const folderKinds = new Set(['const', 'variable', 'property']);
  // Carpetas cerradas por defecto
  const collapsedByDefault = new Set(['const', 'property']);

  let html = '';
  for (const kind of groupOrder) {
    if (!groups[kind]) continue;
    const items = groups[kind];

    if (folderKinds.has(kind)) {
      const startCollapsed = collapsedByDefault.has(kind);
      // Renderizar como grupo colapsable
      html += `<div class="outline-group">
        <div class="outline-group-header${startCollapsed ? ' collapsed' : ''}" data-group="${kind}">
          <span class="outline-group-chevron">▾</span>
          <span class="outline-icon kind-${kind}">${iconLabel[kind]}</span>
          <span class="outline-group-label">${groupLabels[kind]}</span>
          <span class="outline-group-count">${items.length}</span>
        </div>
        <div class="outline-group-body">
          ${items.map((s) => `
            <div class="outline-item" data-line="${s.line}" data-depth="1">
              <span class="outline-icon kind-${s.kind}">${iconLabel[s.kind]}</span>
              <span class="outline-name">${escapeHtml(s.name)}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
    } else {
      // Renderizar directamente
      html += items.map((s) => `
        <div class="outline-item" data-line="${s.line}" data-depth="${s.depth}">
          <span class="outline-icon kind-${s.kind}">${iconLabel[s.kind]}</span>
          <span class="outline-name">${escapeHtml(s.name)}</span>
        </div>
      `).join('');
    }
  }

  listEl.innerHTML = html;

  // Toggle de grupos colapsables
  listEl.querySelectorAll('.outline-group-header').forEach((header) => {
    header.addEventListener('click', () => {
      header.classList.toggle('collapsed');
    });
  });

  // Click navega al símbolo
  listEl.querySelectorAll('.outline-item').forEach((el) => {
    el.addEventListener('click', () => {
      const line = parseInt(el.dataset.line);
      if (state.activeTab && state.activeTab.model && state.editor) {
        if (state.activeTab.path.startsWith('__')) return;
        state.editor.revealLineInCenter(line);
        state.editor.setPosition({ lineNumber: line, column: 1 });
        state.editor.focus();

        listEl.querySelectorAll('.outline-item').forEach((e) => e.classList.remove('active'));
        el.classList.add('active');
      }
    });
  });
}

// ┌──────────────────────────────────────────────────┐
// │  8. GIT PANEL                                    │
// │  Panel de Source Control: muestra staged,         │
// │  unstaged y untracked files con acciones          │
// │  (stage/unstage/discard) y commit. Auto-refresh  │
// │  cada 5s mientras está visible.                  │
// └──────────────────────────────────────────────────┘
function toggleGitPanel() {
  if (state.sidebarView === 'git') {
    showExplorerPanel();
  } else {
    showGitPanel();
  }
}

function setActiveActionButton(activeId) {
  document.querySelectorAll('#sidebar-action-bar button').forEach((btn) => {
    btn.classList.toggle('active', btn.id === activeId);
  });
}

function showExplorerPanel() {
  state.sidebarView = 'explorer';
  document.getElementById('explorer-sections').style.display = '';
  document.getElementById('git-panel').style.display = 'none';
  document.getElementById('search-panel').style.display = 'none';
  document.getElementById('sidebar-header').querySelector('span').textContent =
    state.currentFolder
      ? state.currentFolder.split(/[/\\]/).pop().toUpperCase()
      : 'EXPLORER';
  setActiveActionButton(null);
  if (state.gitRefreshTimer) {
    clearInterval(state.gitRefreshTimer);
    state.gitRefreshTimer = null;
  }
}

function showGitPanel() {
  state.sidebarView = 'git';
  document.getElementById('explorer-sections').style.display = 'none';
  document.getElementById('git-panel').style.display = 'flex';
  document.getElementById('search-panel').style.display = 'none';
  document.getElementById('sidebar-header').querySelector('span').textContent =
    'SOURCE CONTROL';
  setActiveActionButton('btn-toggle-git');
  refreshGitStatus();
  // Auto-refresh cada 5 segundos mientras el panel está visible
  state.gitRefreshTimer = setInterval(refreshGitStatus, 5000);
}

// ┌──────────────────────────────────────────────────┐
// │  8a. SEARCH IN FILES (Cmd+Shift+F)              │
// │  Panel lateral de búsqueda de texto/regex        │
// │  en todos los archivos del proyecto.             │
// └──────────────────────────────────────────────────┘
const searchState = {
  query: '',
  isRegex: false,
  caseSensitive: false,
  results: [],
  searchTimeout: null,
};

function toggleSearchPanel() {
  if (state.sidebarView === 'search') {
    showExplorerPanel();
  } else {
    showSearchPanel();
  }
}

function showSearchPanel() {
  state.sidebarView = 'search';
  document.getElementById('explorer-sections').style.display = 'none';
  document.getElementById('git-panel').style.display = 'none';
  document.getElementById('search-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent = 'SEARCH';
  setActiveActionButton('btn-toggle-search');

  // Hacer visible el sidebar si estaba oculto
  if (!state.sidebarVisible) {
    toggleSidebar();
  }

  // Limpiar auto-refresh de git si estaba activo
  if (state.gitRefreshTimer) {
    clearInterval(state.gitRefreshTimer);
    state.gitRefreshTimer = null;
  }

  // Focus en el input
  setTimeout(() => document.getElementById('search-input').focus(), 50);
}

async function performSearch() {
  const query = searchState.query;
  if (!query || !state.currentFolder) {
    document.getElementById('search-results').innerHTML = '';
    document.getElementById('search-status').textContent = '';
    return;
  }

  document.getElementById('search-status').textContent = 'Searching...';

  const result = await window.api.searchInFiles(state.currentFolder, query, {
    isRegex: searchState.isRegex,
    caseSensitive: searchState.caseSensitive,
  });

  if (result.error) {
    document.getElementById('search-status').textContent = result.error;
    document.getElementById('search-results').innerHTML = '';
    return;
  }

  searchState.results = result.results;
  const count = result.results.length;
  const truncated = result.truncated ? ' (limit reached)' : '';
  document.getElementById('search-status').textContent =
    count === 0 ? 'No results found' : `${count} result${count !== 1 ? 's' : ''}${truncated}`;

  renderSearchResults(result.results, query);
}

function renderSearchResults(results, query) {
  const container = document.getElementById('search-results');

  // Agrupar por archivo
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.file]) {
      grouped[r.file] = { absolutePath: r.absolutePath, matches: [] };
    }
    grouped[r.file].matches.push(r);
  }

  let html = '';
  for (const [file, data] of Object.entries(grouped)) {
    const fileName = file.split(/[/\\]/).pop();
    const dirPath = file.split(/[/\\]/).slice(0, -1).join('/');
    const iconHtml = window.api.getFileIcon(fileName);

    html += `<div class="search-file-group" data-file="${escapeAttr(data.absolutePath)}">`;
    html += `<div class="search-file-header">`;
    html += `<span class="search-file-chevron">▾</span>`;
    html += `<span class="search-file-icon">${iconHtml}</span>`;
    html += `<span>${escapeHtml(fileName)}</span>`;
    if (dirPath) html += `<span style="color:var(--text-muted);font-size:11px;font-weight:400;margin-left:4px">${escapeHtml(dirPath)}</span>`;
    html += `<span class="search-file-count">${data.matches.length}</span>`;
    html += `</div>`;

    for (const m of data.matches) {
      const highlighted = highlightMatch(m.lineText.trimStart(), query, searchState.isRegex, searchState.caseSensitive);
      html += `<div class="search-match" data-path="${escapeAttr(m.absolutePath)}" data-line="${m.line}" data-col="${m.column}">`;
      html += `<span class="search-match-line">${m.line}</span>`;
      html += `<span class="search-match-text">${highlighted}</span>`;
      html += `</div>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html;
}

function highlightMatch(text, query, isRegex, caseSensitive) {
  const escaped = escapeHtml(text);
  try {
    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Escapar el texto primero, luego aplicar el highlight
    // Necesitamos buscar en el texto original y mapear posiciones al HTML escapado
    const regex = new RegExp(pattern, flags);
    let result = '';
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      result += escapeHtml(text.slice(lastIndex, match.index));
      result += `<mark>${escapeHtml(match[0])}</mark>`;
      lastIndex = regex.lastIndex;
      if (match[0].length === 0) break; // prevent infinite loop on zero-width match
    }
    result += escapeHtml(text.slice(lastIndex));
    return result;
  } catch {
    return escaped;
  }
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function initSearchPanel() {
  const input = document.getElementById('search-input');
  const caseBtn = document.getElementById('search-opt-case');
  const regexBtn = document.getElementById('search-opt-regex');
  const resultsContainer = document.getElementById('search-results');

  // Debounce de la búsqueda mientras se escribe
  input.addEventListener('input', () => {
    searchState.query = input.value;
    clearTimeout(searchState.searchTimeout);
    searchState.searchTimeout = setTimeout(performSearch, 300);
  });

  // Enter fuerza búsqueda inmediata
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchState.searchTimeout);
      searchState.query = input.value;
      performSearch();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      showExplorerPanel();
    }
  });

  // Toggle options
  caseBtn.addEventListener('click', () => {
    searchState.caseSensitive = !searchState.caseSensitive;
    caseBtn.classList.toggle('active', searchState.caseSensitive);
    if (searchState.query) performSearch();
  });

  regexBtn.addEventListener('click', () => {
    searchState.isRegex = !searchState.isRegex;
    regexBtn.classList.toggle('active', searchState.isRegex);
    if (searchState.query) performSearch();
  });

  // Click en resultado → abrir archivo en la línea
  resultsContainer.addEventListener('click', (e) => {
    // Collapse/expand file group
    const header = e.target.closest('.search-file-header');
    if (header) {
      header.closest('.search-file-group').classList.toggle('collapsed');
      return;
    }

    // Click en un match → abrir archivo
    const matchEl = e.target.closest('.search-match');
    if (matchEl) {
      const filePath = matchEl.dataset.path;
      const line = parseInt(matchEl.dataset.line, 10);
      const col = parseInt(matchEl.dataset.col, 10);
      const fileName = filePath.split(/[/\\]/).pop();
      openFile(filePath, fileName).then(() => {
        // Ir a la línea y columna
        if (state.editor) {
          state.editor.revealLineInCenter(line);
          state.editor.setPosition({ lineNumber: line, column: col });
          state.editor.focus();
        }
      });
    }
  });

  // Sidebar button
  document.getElementById('btn-toggle-search').addEventListener('click', () => toggleSearchPanel());

  // Menu/keyboard shortcut
  window.api.onMenuSearch(() => showSearchPanel());
}

async function refreshGitStatus() {
  if (!state.currentFolder) return;

  // Obtener branch
  const branchResult = await window.api.gitBranch(state.currentFolder);
  if (!branchResult.error) {
    document.getElementById('status-branch').textContent = `⎇ ${branchResult.output}`;
  }

  // Obtener status
  const statusResult = await window.api.gitStatus(state.currentFolder);
  if (statusResult.error) return;

  const { files } = statusResult;
  renderGitFiles(files);
}

/**
 * Renderiza las 3 secciones del git panel de una sola vez.
 * Genera todo el HTML como string y lo inyecta con innerHTML.
 * Event delegation único desde #git-file-sections.
 */
function renderGitFiles(files) {
  const container = document.getElementById('git-file-sections');
  if (!container) return;

  function buildSection(title, items, type) {
    if (!items.length) return '';

    const rows = items.map((file) => {
      const fileName = file.path.split(/[/\\]/).pop();
      const statusLabel = file.status[0].toUpperCase();
      const deletedClass = file.status === 'deleted' ? ' git-file-deleted' : '';

      let buttons = '';
      if (type === 'staged') {
        buttons = `<button class="git-action-btn" data-action="unstage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Unstage">−</button>`;
      } else if (type === 'unstaged') {
        buttons = `<button class="git-action-btn" data-action="stage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Stage">+</button>
          <button class="git-action-btn" data-action="discard" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Discard">↺</button>`;
      } else {
        buttons = `<button class="git-action-btn" data-action="stage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Stage">+</button>`;
      }

      return `<div class="git-file-item">
        <span class="git-file-name${deletedClass}" data-type="${type}" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" data-status="${file.status}" title="${escapeAttr(file.path)}">${escapeHtml(fileName)}</span>
        <span class="git-file-status git-status-${file.status}">${statusLabel}</span>
        <div class="git-file-actions">${buttons}</div>
      </div>`;
    }).join('');

    return `<div class="git-section">
      <div class="git-section-header" data-section="${type}">
        <span class="git-section-chevron">▾</span>
        <span class="git-section-title">${escapeHtml(title)}</span>
        <span class="git-section-count">${items.length}</span>
      </div>
      <div class="git-section-list">${rows}</div>
    </div>`;
  }

  container.innerHTML =
    buildSection('Staged Changes', files.staged, 'staged') +
    buildSection('Changes', files.unstaged, 'unstaged') +
    buildSection('Untracked', files.untracked, 'untracked');
}

async function gitCommit() {
  const input = document.getElementById('git-commit-input');
  const message = input.value.trim();
  if (!message) {
    input.focus();
    return;
  }

  const result = await window.api.gitCommit(state.currentFolder, message);
  if (result.error) {
    console.error('Git commit error:', result.error);
  } else {
    input.value = '';
    refreshGitStatus();
  }
}

async function gitPull() {
  const btn = document.getElementById('git-pull-btn');
  btn.classList.add('syncing');
  btn.querySelector('span').textContent = 'Pulling...';

  const result = await window.api.gitPull(state.currentFolder);

  btn.classList.remove('syncing');
  btn.querySelector('span').textContent = 'Pull';

  if (result.error) {
    console.error('Git pull error:', result.error);
    alert(`Pull failed:\n${result.stderr || result.error}`);
  } else {
    refreshGitStatus();
  }
}

async function gitPush() {
  const btn = document.getElementById('git-push-btn');
  btn.classList.add('syncing');
  btn.querySelector('span').textContent = 'Pushing...';

  const result = await window.api.gitPush(state.currentFolder);

  btn.classList.remove('syncing');
  btn.querySelector('span').textContent = 'Push';

  if (result.error) {
    console.error('Git push error:', result.error);
    alert(`Push failed:\n${result.stderr || result.error}`);
  } else {
    refreshGitStatus();
  }
}

function initGitPanel() {
  // Commit
  document.getElementById('git-commit-btn').addEventListener('click', gitCommit);
  document.getElementById('git-commit-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gitCommit();
  });

  // Push / Pull
  document.getElementById('git-pull-btn').addEventListener('click', gitPull);
  document.getElementById('git-push-btn').addEventListener('click', gitPush);

  // Git graph — abrir como tab
  document.getElementById('btn-git-graph')?.addEventListener('click', () => {
    openGitGraph();
  });

  // Event delegation único para todo el panel de archivos git
  const sectionsEl = document.getElementById('git-file-sections');

  sectionsEl.addEventListener('click', async (e) => {
    // Collapse/expand de secciones
    const header = e.target.closest('.git-section-header');
    if (header) {
      const chevron = header.querySelector('.git-section-chevron');
      const list = header.nextElementSibling;
      if (chevron && list) {
        chevron.classList.toggle('collapsed');
        list.classList.toggle('collapsed');
      }
      return;
    }

    // Click en nombre de archivo → abrir diff o archivo
    const nameEl = e.target.closest('.git-file-name');
    if (nameEl) {
      const filePath = nameEl.dataset.path;
      const absPath = nameEl.dataset.abs;
      const status = nameEl.dataset.status;
      const type = nameEl.dataset.type;
      const fileName = filePath.split(/[/\\]/).pop();

      if (status === 'deleted') return;
      if (type === 'untracked') {
        openFile(absPath, fileName);
      } else {
        openDiffView(filePath, absPath, fileName, type === 'staged');
      }
      return;
    }

    // Click en botones de acción (stage/unstage/discard)
    const btn = e.target.closest('.git-action-btn');
    if (!btn) return;

    e.stopPropagation();
    const action = btn.dataset.action;
    const filePath = btn.dataset.path;

    // Loading state
    const originalText = btn.textContent;
    btn.classList.add('git-action-loading');
    btn.textContent = '⟳';
    btn.disabled = true;

    if (action === 'stage') {
      await window.api.gitAdd(state.currentFolder, [filePath]);
      refreshGitStatus();
    } else if (action === 'unstage') {
      await window.api.gitUnstage(state.currentFolder, [filePath]);
      refreshGitStatus();
    } else if (action === 'discard') {
      btn.classList.remove('git-action-loading');
      btn.textContent = originalText;
      btn.disabled = false;
      if (confirm(`Discard changes to ${filePath}?`)) {
        btn.classList.add('git-action-loading');
        btn.textContent = '⟳';
        btn.disabled = true;
        await window.api.gitDiscard(state.currentFolder, filePath);
        refreshGitStatus();
      }
    }
  });
}

// ┌──────────────────────────────────────────────────┐
// │  9. EVENT LISTENERS                              │
// │  Conexión de botones del titlebar, sidebar,      │
// │  eventos del menú nativo (via IPC), y atajos     │
// │  de teclado globales (Cmd+B, Cmd+`, Cmd+P/W).   │
// └──────────────────────────────────────────────────┘
function initEventListeners() {
  // Titlebar buttons
  document.getElementById('btn-minimize').addEventListener('click', () =>
    window.api.windowMinimize()
  );
  document.getElementById('btn-maximize').addEventListener('click', () =>
    window.api.windowMaximize()
  );
  document.getElementById('btn-close').addEventListener('click', () =>
    window.api.windowClose()
  );

  // Sidebar buttons
  document.getElementById('btn-open-terminal').addEventListener('click', () =>
    toggleTerminal()
  );
  document.getElementById('btn-toggle-git').addEventListener('click', () =>
    toggleGitPanel()
  );
  document.getElementById('btn-open-folder').addEventListener('click', () =>
    window.api.openFolder()
  );
  document.getElementById('btn-open-folder-cta')?.addEventListener('click', () =>
    window.api.openFolder()
  );

  // Menu events desde el main process
  window.api.onMenuSave(() => saveCurrentFile());
  window.api.onMenuToggleSidebar(() => toggleSidebar());
  window.api.onMenuToggleTerminal(() => toggleTerminal());
  window.api.onMenuSwitchTheme((theme) => switchTheme(theme));
  window.api.onFolderOpened((path) => loadFileTree(path));
  window.api.onFileOpened((path) => {
    const name = path.split(/[/\\]/).pop();
    openFile(path, name);
  });

  // Keyboard shortcuts (complementan los del menú)
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    if (mod && e.key === '`') { e.preventDefault(); toggleTerminal(); }
    if (mod && e.key === 'p') { e.preventDefault(); toggleQuickOpen(); }
    if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); showSearchPanel(); }
    if (mod && e.key === 't') { e.preventDefault(); toggleSymbolSearch(); }
    if (mod && e.key === 'w') { e.preventDefault(); if (state.activeTab) closeTab(state.activeTab.path); }
  });
}

// ┌──────────────────────────────────────────────────┐
// │  8b. THEME SWITCHER                              │
// │  Alterna entre dark y light aplicando CSS vars,  │
// │  Monaco themes, y persistiendo en localStorage.  │
// │  Sincroniza con el menú nativo via IPC.          │
// └──────────────────────────────────────────────────┘
function switchTheme(themeName) {
  // Aplicar CSS variables
  document.documentElement.setAttribute('data-theme', themeName);

  // Aplicar Monaco theme
  const monacoTheme = themeName === 'light' ? 'mojavecode-php-light' : 'mojavecode-php-dark';
  monaco.editor.setTheme(monacoTheme);

  // Persistir preferencia y sincronizar menú nativo
  localStorage.setItem('mojavecode-php-theme', themeName);
  window.api.syncTheme(themeName);
}

function initThemeMenu() {
  // Restaurar tema guardado al iniciar
  const saved = localStorage.getItem('mojavecode-php-theme') || 'dark';
  switchTheme(saved);
}

// ┌──────────────────────────────────────────────────┐
// │  8c. ERROR LOG                                   │
// │  Captura console.error, errores no manejados,    │
// │  y promesas rechazadas. Los muestra en un tab    │
// │  dedicado con badge en el status bar.            │
// └──────────────────────────────────────────────────┘
const errorLog = {
  entries: [],
};

function initErrorLog() {
  const badge = document.getElementById('status-errors');

  // Interceptar console.error (no warnings)
  const originalError = console.error.bind(console);
  console.error = (...args) => {
    originalError(...args);
    const msg = args.map((a) =>
      typeof a === 'string' ? a : (a instanceof Error ? a.stack || a.message : JSON.stringify(a, null, 2))
    ).join(' ');
    errorLog.entries.push({ time: new Date(), message: msg });
    updateErrorBadge();
    // Si el tab está abierto, refrescar
    if (state.activeTab?.path === '__errorlog__') renderErrorLog();
  };

  // Capturar errores no manejados
  window.addEventListener('error', (e) => {
    errorLog.entries.push({
      time: new Date(),
      message: `${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`,
    });
    updateErrorBadge();
    if (state.activeTab?.path === '__errorlog__') renderErrorLog();
  });

  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason instanceof Error
      ? e.reason.stack || e.reason.message
      : String(e.reason);
    errorLog.entries.push({ time: new Date(), message: `Unhandled Promise: ${msg}` });
    updateErrorBadge();
    if (state.activeTab?.path === '__errorlog__') renderErrorLog();
  });

  // Click en badge abre el tab
  badge.addEventListener('click', () => openErrorLog());
}

function updateErrorBadge() {
  const badge = document.getElementById('status-errors');
  const count = errorLog.entries.length;
  if (count > 0) {
    badge.style.display = 'flex';
    badge.textContent = `\u2716 ${count}`;
  } else {
    badge.style.display = 'none';
  }
}

function openErrorLog() {
  const existing = state.openTabs.find((t) => t.path === '__errorlog__');
  if (existing) {
    activateTab(existing);
    renderErrorLog();
    return;
  }

  const tab = {
    path: '__errorlog__',
    name: 'Error Log',
    model: null,
    language: 'errorlog',
    modified: false,
  };
  state.openTabs.push(tab);
  activateTab(tab);
  renderErrorLog();
}

function renderErrorLog() {
  const container = document.getElementById('errorlog-container');

  let entriesHTML;
  if (!errorLog.entries.length) {
    entriesHTML = '<div class="errorlog-empty">No errors logged</div>';
  } else {
    entriesHTML = errorLog.entries.slice().reverse().map((e) => {
      const time = e.time.toLocaleTimeString();
      return `<div class="errorlog-entry">
        <span class="errorlog-time">${time}</span>
        <span class="errorlog-msg">${escapeHtml(e.message)}</span>
      </div>`;
    }).join('');
  }

  container.innerHTML = `
    <div class="errorlog-header">
      <span class="errorlog-title">Error Log (${errorLog.entries.length})</span>
      <button class="errorlog-clear">Clear</button>
    </div>
    <div class="errorlog-list">${entriesHTML}</div>
  `;

  container.querySelector('.errorlog-clear').addEventListener('click', () => {
    errorLog.entries = [];
    updateErrorBadge();
    renderErrorLog();
  });
}

// ┌──────────────────────────────────────────────────┐
// │  8d. QUICK OPEN (Cmd+P)                          │
// │  Diálogo de búsqueda fuzzy de archivos con       │
// │  navegación por teclado (arrows + Enter),        │
// │  highlight de matches, y cache de archivos.      │
// └──────────────────────────────────────────────────┘
const quickOpen = {
  overlay: null,
  input: null,
  resultsList: null,
  allFiles: [],
  filtered: [],
  selectedIndex: 0,
  visible: false,
  cachedFolder: null, // folder al que pertenece el cache actual
};

async function toggleQuickOpen() {
  if (quickOpen.visible) {
    closeQuickOpen();
    return;
  }

  if (!state.currentFolder) return;

  quickOpen.overlay = document.getElementById('quick-open-overlay');
  quickOpen.input = document.getElementById('quick-open-input');
  quickOpen.resultsList = document.getElementById('quick-open-results');

  // Recargar cache si cambió de folder o si está vacío
  const folderChanged = quickOpen.cachedFolder !== state.currentFolder;
  if (!quickOpen.allFiles.length || folderChanged) {
    quickOpen.resultsList.innerHTML = '<div class="qo-empty">Indexing files...</div>';
    const targetFolder = state.currentFolder;
    const files = await window.api.listAllFiles(targetFolder);
    // Verificar que no cambió de folder mientras se indexaba (race condition)
    if (state.currentFolder !== targetFolder) return;
    quickOpen.allFiles = files.map((f) => ({
      fullPath: f,
      relativePath: f.replace(targetFolder + '/', ''),
      name: f.split('/').pop(),
    }));
    quickOpen.cachedFolder = targetFolder;
  }

  quickOpen.visible = true;
  quickOpen.overlay.style.display = 'flex';
  quickOpen.input.value = '';
  quickOpen.selectedIndex = 0;
  renderQuickOpenResults('');
  quickOpen.input.focus();
}

function closeQuickOpen() {
  quickOpen.visible = false;
  quickOpen.overlay.style.display = 'none';
  quickOpen.input.value = '';
  state.editor?.focus();
}

function renderQuickOpenResults(query) {
  const q = query.toLowerCase();

  if (!q) {
    // Sin query: mostrar archivos recientes (tabs abiertos) + primeros archivos
    const openPaths = new Set(state.openTabs.map((t) => t.path));
    const recent = quickOpen.allFiles.filter((f) => openPaths.has(f.fullPath));
    const rest = quickOpen.allFiles.filter((f) => !openPaths.has(f.fullPath)).slice(0, 20);
    quickOpen.filtered = [...recent, ...rest];
  } else {
    // Fuzzy match: todas las letras del query deben aparecer en orden en el nombre
    quickOpen.filtered = quickOpen.allFiles
      .map((f) => {
        const name = f.name.toLowerCase();
        const rel = f.relativePath.toLowerCase();
        let score = 0;
        let qi = 0;

        // Primero intentar match en el nombre del archivo
        for (let i = 0; i < name.length && qi < q.length; i++) {
          if (name[i] === q[qi]) {
            score += (i === 0 || name[i - 1] === '/' || name[i - 1] === '.' || name[i - 1] === '-' || name[i - 1] === '_') ? 10 : 1;
            qi++;
          }
        }

        if (qi === q.length) return { ...f, score };

        // Fallback: match en path completo
        qi = 0;
        score = 0;
        for (let i = 0; i < rel.length && qi < q.length; i++) {
          if (rel[i] === q[qi]) {
            score += 1;
            qi++;
          }
        }

        return qi === q.length ? { ...f, score: score - 5 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
  }

  quickOpen.selectedIndex = 0;

  if (!quickOpen.filtered.length) {
    quickOpen.resultsList.innerHTML = '<div class="qo-empty">No files found</div>';
    return;
  }

  quickOpen.resultsList.innerHTML = quickOpen.filtered.map((f, i) => {
    const highlighted = q ? highlightMatch(f.name, q) : escapeHtml(f.name);
    const dir = f.relativePath.includes('/') ? f.relativePath.replace(/\/[^/]+$/, '') : '';
    return `<div class="qo-item${i === 0 ? ' selected' : ''}" data-index="${i}">
      <span class="qo-name">${highlighted}</span>
      <span class="qo-path">${escapeHtml(dir)}</span>
    </div>`;
  }).join('');

  // Click handlers
  quickOpen.resultsList.querySelectorAll('.qo-item').forEach((el) => {
    el.addEventListener('click', () => {
      const file = quickOpen.filtered[parseInt(el.dataset.index)];
      if (file) {
        openFile(file.fullPath, file.name);
        closeQuickOpen();
      }
    });
  });
}

function highlightMatch(name, query) {
  const lower = name.toLowerCase();
  let result = '';
  let qi = 0;
  for (let i = 0; i < name.length; i++) {
    if (qi < query.length && lower[i] === query[qi]) {
      result += `<mark>${escapeHtml(name[i])}</mark>`;
      qi++;
    } else {
      result += escapeHtml(name[i]);
    }
  }
  return result;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function updateQuickOpenSelection() {
  quickOpen.resultsList.querySelectorAll('.qo-item').forEach((el, i) => {
    el.classList.toggle('selected', i === quickOpen.selectedIndex);
  });
  // Scroll into view
  const selected = quickOpen.resultsList.querySelector('.qo-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function initQuickOpen() {
  const input = document.getElementById('quick-open-input');
  const overlay = document.getElementById('quick-open-overlay');

  input.addEventListener('input', () => {
    renderQuickOpenResults(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeQuickOpen();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (quickOpen.selectedIndex < quickOpen.filtered.length - 1) {
        quickOpen.selectedIndex++;
        updateQuickOpenSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (quickOpen.selectedIndex > 0) {
        quickOpen.selectedIndex--;
        updateQuickOpenSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = quickOpen.filtered[quickOpen.selectedIndex];
      if (file) {
        openFile(file.fullPath, file.name);
        closeQuickOpen();
      }
    }
  });

  // Click en overlay cierra
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeQuickOpen();
  });
}

// ┌──────────────────────────────────────────────────┐
// │  9a2. GO TO SYMBOL (Cmd+T)                       │
// │  Busca clases, funciones, métodos en todo el     │
// │  proyecto con fuzzy matching e íconos por kind.   │
// └──────────────────────────────────────────────────┘
const symbolSearch = {
  visible: false,
  allSymbols: [],
  filtered: [],
  selectedIndex: 0,
  cachedFolder: null,
  overlay: null,
  input: null,
  resultsList: null,
  statusEl: null,
};

const symbolKindIcon = {
  class: 'C', interface: 'I', function: 'ƒ', method: 'm',
  const: 'c', variable: 'v', property: 'p',
};

async function toggleSymbolSearch() {
  if (symbolSearch.visible) {
    closeSymbolSearch();
    return;
  }

  if (!state.currentFolder) return;

  symbolSearch.overlay = document.getElementById('symbol-search-overlay');
  symbolSearch.input = document.getElementById('symbol-search-input');
  symbolSearch.resultsList = document.getElementById('symbol-search-results');
  symbolSearch.statusEl = document.getElementById('symbol-search-status');

  // Reindexar si cambió de folder o si no tenemos cache
  const folderChanged = symbolSearch.cachedFolder !== state.currentFolder;
  if (!symbolSearch.allSymbols.length || folderChanged) {
    symbolSearch.statusEl.textContent = 'Indexing symbols...';
    symbolSearch.resultsList.innerHTML = '';
    const targetFolder = state.currentFolder;
    const result = await window.api.searchSymbols(targetFolder);
    if (state.currentFolder !== targetFolder) return; // race condition
    symbolSearch.allSymbols = result.symbols;
    symbolSearch.cachedFolder = targetFolder;
    symbolSearch.statusEl.textContent = `${result.symbols.length} symbols indexed`;
  }

  symbolSearch.visible = true;
  symbolSearch.overlay.style.display = 'flex';
  symbolSearch.input.value = '';
  symbolSearch.selectedIndex = 0;
  renderSymbolResults('');
  symbolSearch.input.focus();
}

function closeSymbolSearch() {
  symbolSearch.visible = false;
  symbolSearch.overlay.style.display = 'none';
  symbolSearch.input.value = '';
}

function renderSymbolResults(query) {
  const q = query.toLowerCase().trim();

  if (!q) {
    // Sin query: mostrar clases e interfaces primero (más útiles)
    symbolSearch.filtered = symbolSearch.allSymbols
      .filter((s) => s.kind === 'class' || s.kind === 'interface')
      .slice(0, 50);
    if (symbolSearch.filtered.length < 50) {
      const rest = symbolSearch.allSymbols
        .filter((s) => s.kind !== 'class' && s.kind !== 'interface')
        .slice(0, 50 - symbolSearch.filtered.length);
      symbolSearch.filtered.push(...rest);
    }
  } else {
    // Fuzzy match en nombre del símbolo
    symbolSearch.filtered = symbolSearch.allSymbols
      .map((s) => {
        const name = s.name.toLowerCase();
        let score = 0;
        let qi = 0;

        for (let i = 0; i < name.length && qi < q.length; i++) {
          if (name[i] === q[qi]) {
            // Bonus por match al inicio o después de separador
            score += (i === 0 || name[i - 1] === '_') ? 15 : 1;
            // Bonus por match exacto desde el inicio
            if (i === qi) score += 5;
            qi++;
          }
        }

        if (qi < q.length) return null;

        // Bonus por tipo: clases e interfaces ranquean más alto
        if (s.kind === 'class' || s.kind === 'interface') score += 3;

        // Bonus por coincidencia exacta de longitud
        if (name.length === q.length) score += 20;

        return { ...s, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  symbolSearch.selectedIndex = 0;

  if (!symbolSearch.filtered.length) {
    symbolSearch.resultsList.innerHTML = '<div class="qo-empty" style="padding:12px;text-align:center;color:var(--text-muted);font-size:13px;">No symbols found</div>';
    symbolSearch.statusEl.textContent = 'No results';
    return;
  }

  symbolSearch.statusEl.textContent = q
    ? `${symbolSearch.filtered.length} match${symbolSearch.filtered.length !== 1 ? 'es' : ''}`
    : `${symbolSearch.allSymbols.length} symbols indexed`;

  symbolSearch.resultsList.innerHTML = symbolSearch.filtered.map((s, i) => {
    const highlighted = q ? highlightSymbolMatch(s.name, q) : escapeHtml(s.name);
    const icon = symbolKindIcon[s.kind] || '?';
    const dirParts = s.file.split(/[/\\]/);
    const fileName = dirParts.pop();
    const dirPath = dirParts.join('/');
    return `<div class="sym-item${i === 0 ? ' selected' : ''}" data-index="${i}">
      <span class="sym-icon kind-${s.kind}">${icon}</span>
      <span class="sym-name">${highlighted}</span>
      <span class="sym-kind-label">${s.kind}</span>
      <span class="sym-detail" title="${escapeHtml(s.file)}:${s.line}">${escapeHtml(fileName)}${dirPath ? ' <span style="opacity:0.6">' + escapeHtml(dirPath) + '</span>' : ''}</span>
    </div>`;
  }).join('');

  // Click handlers
  symbolSearch.resultsList.querySelectorAll('.sym-item').forEach((el) => {
    el.addEventListener('click', () => {
      const sym = symbolSearch.filtered[parseInt(el.dataset.index)];
      if (sym) openSymbolResult(sym);
    });
  });
}

function highlightSymbolMatch(name, query) {
  const lower = name.toLowerCase();
  let result = '';
  let qi = 0;
  for (let i = 0; i < name.length; i++) {
    if (qi < query.length && lower[i] === query[qi]) {
      result += `<mark>${escapeHtml(name[i])}</mark>`;
      qi++;
    } else {
      result += escapeHtml(name[i]);
    }
  }
  return result;
}

function openSymbolResult(sym) {
  closeSymbolSearch();
  const fileName = sym.absolutePath.split(/[/\\]/).pop();
  openFile(sym.absolutePath, fileName).then(() => {
    if (state.editor) {
      state.editor.revealLineInCenter(sym.line);
      state.editor.setPosition({ lineNumber: sym.line, column: 1 });
      state.editor.focus();
    }
  });
}

function updateSymbolSearchSelection() {
  symbolSearch.resultsList.querySelectorAll('.sym-item').forEach((el, i) => {
    el.classList.toggle('selected', i === symbolSearch.selectedIndex);
  });
  const selected = symbolSearch.resultsList.querySelector('.sym-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function initSymbolSearch() {
  const input = document.getElementById('symbol-search-input');
  const overlay = document.getElementById('symbol-search-overlay');

  input.addEventListener('input', () => {
    renderSymbolResults(input.value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSymbolSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (symbolSearch.selectedIndex < symbolSearch.filtered.length - 1) {
        symbolSearch.selectedIndex++;
        updateSymbolSearchSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (symbolSearch.selectedIndex > 0) {
        symbolSearch.selectedIndex--;
        updateSymbolSearchSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sym = symbolSearch.filtered[symbolSearch.selectedIndex];
      if (sym) openSymbolResult(sym);
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSymbolSearch();
  });

  // Menu event
  window.api.onMenuGoToSymbol(() => toggleSymbolSearch());
}

// ┌──────────────────────────────────────────────────┐
// │  9b. COMPOSER & ARTISAN INTEGRATION              │
// │  Input prompt, ejecución de comandos, y output   │
// │  panel para Composer y Artisan desde el menú.    │
// └──────────────────────────────────────────────────┘

/**
 * Abre el command prompt dialog con un label y placeholder.
 * Retorna una Promise que se resuelve con el input del usuario
 * o null si cancela.
 */
function showCommandPrompt(label, placeholder, hint) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('command-prompt-overlay');
    const input = document.getElementById('command-prompt-input');
    const labelEl = document.getElementById('command-prompt-label');
    const hintEl = document.getElementById('command-prompt-hint');

    labelEl.textContent = label;
    input.placeholder = placeholder || '';
    input.value = '';
    hintEl.textContent = hint || 'Enter to confirm, Esc to cancel';
    overlay.style.display = 'flex';
    input.focus();

    function cleanup() {
      overlay.style.display = 'none';
      input.removeEventListener('keydown', onKey);
      overlay.removeEventListener('click', onOverlay);
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
        resolve(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const val = input.value.trim();
        cleanup();
        resolve(val || null);
      }
    }

    function onOverlay(e) {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    }

    input.addEventListener('keydown', onKey);
    overlay.addEventListener('click', onOverlay);
  });
}

/**
 * Muestra el output de un comando en un tab especial __command-output__.
 */
function showCommandOutput(title, output, error, code) {
  const tabPath = '__command-output__';
  const existing = state.openTabs.find((t) => t.path === tabPath);
  if (!existing) {
    const tab = {
      path: tabPath,
      name: 'Output',
      model: null,
      language: 'output',
      modified: false,
    };
    state.openTabs.push(tab);
    activateTab(tab);
  } else {
    activateTab(existing);
  }

  const container = document.getElementById('command-output-container');
  const isError = code !== 0 && error;
  const bodyText = (output || '') + (error && output ? '\n' : '') + (error || '');

  container.innerHTML = `
    <div class="cmd-output-header">
      <span class="cmd-output-title">${escapeHtml(title)}</span>
      <button class="cmd-output-close" id="cmd-output-close-btn">Close</button>
    </div>
    <div class="cmd-output-body ${isError ? 'cmd-output-error' : 'cmd-output-success'}">${escapeHtml(bodyText || 'Done (no output)')}</div>
  `;

  document.getElementById('cmd-output-close-btn').addEventListener('click', () => {
    closeTab(tabPath);
  });
}

/**
 * Ejecutar un comando de Composer y mostrar output.
 */
async function runComposerCommand(subcommand, args) {
  const fullCmd = `composer ${subcommand}${args ? ' ' + args : ''}`;
  showCommandOutput(`Running: ${fullCmd}`, 'Executing...', null, 0);

  const result = await window.api.composerExec(subcommand, args || '');
  showCommandOutput(
    `$ ${fullCmd}`,
    result.output || '',
    result.error || '',
    result.code
  );

  // Refrescar file tree si el comando pudo haber cambiado archivos
  if (state.currentFolder && ['install', 'update', 'require', 'remove'].some((c) => subcommand.includes(c))) {
    const treeEl = document.getElementById('file-tree');
    treeEl.innerHTML = '';
    await renderTreeLevel(state.currentFolder, treeEl, 0);
  }
}

/**
 * Ejecutar un comando de Artisan y mostrar output.
 */
async function runArtisanCommand(subcommand, args) {
  const fullCmd = `php artisan ${subcommand}${args ? ' ' + args : ''}`;
  showCommandOutput(`Running: ${fullCmd}`, 'Executing...', null, 0);

  const result = await window.api.artisanExec(subcommand, args || '');
  showCommandOutput(
    `$ ${fullCmd}`,
    result.output || '',
    result.error || '',
    result.code
  );

  // Si fue un make:* o module:make*, refrescar file tree para mostrar el archivo nuevo
  if (state.currentFolder && (subcommand.startsWith('make:') || subcommand.startsWith('module:make'))) {
    const treeEl = document.getElementById('file-tree');
    treeEl.innerHTML = '';
    await renderTreeLevel(state.currentFolder, treeEl, 0);
  }
}



/**
 * Inicializar listeners de Composer y Artisan.
 */
function initComposerArtisan() {
  // ── Composer ──
  window.api.onComposerRun((cmd) => {
    runComposerCommand(cmd);
  });

  window.api.onComposerPrompt(async (cmd) => {
    // cmd es "require", "require --dev", "remove", "run-script"
    const labels = {
      'require': { label: 'Composer Require', placeholder: 'vendor/package', hint: 'e.g. laravel/sanctum' },
      'require --dev': { label: 'Composer Require (dev)', placeholder: 'vendor/package', hint: 'e.g. phpunit/phpunit' },
      'remove': { label: 'Composer Remove', placeholder: 'vendor/package', hint: 'Package to remove' },
      'run-script': { label: 'Composer Run Script', placeholder: 'script-name', hint: 'e.g. test, post-install-cmd' },
    };
    const config = labels[cmd] || { label: `composer ${cmd}`, placeholder: 'arguments', hint: '' };
    const input = await showCommandPrompt(config.label, config.placeholder, config.hint);
    if (input) {
      // Para "require --dev", split: subcommand="require", args="--dev package"
      if (cmd === 'require --dev') {
        runComposerCommand('require', `--dev ${input}`);
      } else {
        runComposerCommand(cmd, input);
      }
    }
  });

  // ── Artisan ──
  window.api.onArtisanRun((cmd) => {
    runArtisanCommand(cmd);
  });

  window.api.onArtisanPrompt(async (cmd) => {
    // cmd es "make:model", "make:controller", "", "module:make", etc.
    let label, placeholder, hint;

    if (cmd === '') {
      // Custom command
      label = 'Artisan Command';
      placeholder = 'command [arguments]';
      hint = 'e.g. make:model Post -mfsc, queue:work';
    } else if (cmd.startsWith('module:')) {
      // Laravel Modules commands
      const parts = cmd.replace('module:', '');
      label = `php artisan ${cmd}`;
      if (cmd === 'module:make') {
        placeholder = 'ModuleName';
        hint = 'Name of the new module';
      } else if (cmd.startsWith('module:make-')) {
        placeholder = 'Name ModuleName';
        hint = 'e.g. UserController Blog';
      } else {
        // migrate, seed, enable, disable
        placeholder = 'ModuleName';
        hint = 'Module name (leave empty for all modules)';
      }
    } else {
      // Standard artisan make:* commands
      const type = cmd.replace('make:', '');
      label = `php artisan ${cmd}`;
      placeholder = type.charAt(0).toUpperCase() + type.slice(1) + 'Name';
      hint = `e.g. ${type === 'migration' ? 'create_posts_table' : 'User'}`;
    }

    const input = await showCommandPrompt(label, placeholder, hint);
    if (input) {
      if (cmd === '') {
        // Custom command: first word is subcommand, rest is args
        const parts = input.split(/\s+/);
        runArtisanCommand(parts[0], parts.slice(1).join(' '));
      } else {
        runArtisanCommand(cmd, input);
      }
    }
  });

  // ── Tinker ──
  window.api.onArtisanTinker(() => {
    // Abrir terminal y ejecutar tinker ahí
    const existing = state.openTabs.find((t) => t.path === '__terminal__');
    if (!existing) {
      toggleTerminal();
    } else {
      activateTab(existing);
    }
    // Enviar comando al pty
    setTimeout(() => {
      window.api.ptyWrite('php artisan tinker\n');
    }, existing ? 100 : 500);
  });
}

// ┌──────────────────────────────────────────────────┐
// │  9c. DATABASE VIEWER                              │
// │  Panel con tablas y columnas del proyecto,        │
// │  conectado via CLI de mysql/psql leyendo .env.    │
// └──────────────────────────────────────────────────┘

async function openDbViewer() {
  const tabPath = '__db-viewer__';
  const existing = state.openTabs.find((t) => t.path === tabPath);
  if (existing) {
    activateTab(existing);
    loadDbTables(); // Refresh
    return;
  }

  const tab = { path: tabPath, name: 'Database', model: null, language: 'database', modified: false };
  state.openTabs.push(tab);
  activateTab(tab);
  loadDbTables();
}

async function loadDbTables() {
  const container = document.getElementById('db-viewer-container');
  container.innerHTML = '<div class="db-loading">Connecting to database...</div>';

  const config = await window.api.dbGetConfig();
  if (config.error) {
    container.innerHTML = `
      <div class="db-error">Database config error</div>
      <pre class="route-raw-output">${escapeHtml(config.error)}</pre>`;
    console.error('[DB Viewer]', config.error);
    return;
  }

  const result = await window.api.dbGetTables();
  if (result.error) {
    container.innerHTML = `
      <div class="db-header">
        <span class="db-header-title">${escapeHtml(config.database)} (${config.connection})</span>
        <span class="db-header-host">${escapeHtml(config.host)}:${config.port}</span>
      </div>
      <div class="db-error">Connection failed</div>
      <pre class="route-raw-output">${escapeHtml(result.error)}</pre>`;
    console.error('[DB Viewer]', result.error);
    return;
  }

  let html = `
    <div class="db-header">
      <span class="db-header-title">${escapeHtml(config.database)}</span>
      <span class="db-header-host">${escapeHtml(config.connection)}://${escapeHtml(config.host)}:${config.port}</span>
      <span class="db-header-count">${result.tables.length} tables</span>
    </div>
    <div class="db-table-list">`;

  for (const table of result.tables) {
    html += `
      <div class="db-table-group" data-table="${escapeAttr(table)}">
        <div class="db-table-header">
          <span class="db-table-chevron">▸</span>
          <span class="db-table-icon">T</span>
          <span class="db-table-name">${escapeHtml(table)}</span>
        </div>
        <div class="db-table-columns" style="display:none"></div>
      </div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // Click handlers: expand/collapse tables
  container.querySelectorAll('.db-table-header').forEach((header) => {
    header.addEventListener('click', async () => {
      const group = header.closest('.db-table-group');
      const columnsEl = group.querySelector('.db-table-columns');
      const chevron = group.querySelector('.db-table-chevron');
      const isOpen = columnsEl.style.display !== 'none';

      if (isOpen) {
        columnsEl.style.display = 'none';
        chevron.textContent = '▸';
        return;
      }

      chevron.textContent = '▾';
      columnsEl.style.display = 'block';

      // Cargar columnas si aún no se cargaron
      if (!columnsEl.dataset.loaded) {
        columnsEl.innerHTML = '<div class="db-col-loading">Loading...</div>';
        const tableName = group.dataset.table;
        const colResult = await window.api.dbGetColumns(tableName);

        if (colResult.error) {
          columnsEl.innerHTML = `<div class="db-error" style="padding:4px 24px;font-size:11px">${escapeHtml(colResult.error)}</div>`;
          console.error(`[DB Viewer] ${tableName}:`, colResult.error);
        } else {
          // Columnas
          let colsHtml = colResult.columns.map((col) => `
            <div class="db-column">
              <span class="db-col-key">${col.key === 'PRI' ? '🔑' : col.key === 'MUL' ? '🔗' : '  '}</span>
              <span class="db-col-name">${escapeHtml(col.name)}</span>
              <span class="db-col-type">${escapeHtml(col.type)}</span>
              <span class="db-col-nullable">${col.nullable ? 'NULL' : 'NOT NULL'}</span>
            </div>`).join('');

          // Buscador
          const colOptions = colResult.columns.map((c) =>
            `<option value="${escapeAttr(c.name)}">${escapeHtml(c.name)}</option>`
          ).join('');

          colsHtml += `
            <div class="db-query-toggle">
              <span class="db-query-toggle-chevron">▾</span>
              <span>Query</span>
            </div>
            <div class="db-query-body">
            <div class="db-query-bar">
              <select class="db-query-col">${colOptions}</select>
              <select class="db-query-op">
                <option value="=">=</option>
                <option value="!=">!=</option>
                <option value="LIKE">LIKE</option>
                <option value="NOT LIKE">NOT LIKE</option>
                <option value=">">&gt;</option>
                <option value="<">&lt;</option>
                <option value=">=">>=</option>
                <option value="<="><=</option>
                <option value="IS NULL">IS NULL</option>
                <option value="IS NOT NULL">IS NOT NULL</option>
              </select>
              <input class="db-query-val" type="text" placeholder="value..." />
              <button class="db-query-run">Search</button>
              <button class="db-query-all">All rows</button>
            </div>
            <div class="db-query-results"></div>
            </div>`;

          columnsEl.innerHTML = colsHtml;

          // Toggle del query panel
          const queryToggle = columnsEl.querySelector('.db-query-toggle');
          const queryBody = columnsEl.querySelector('.db-query-body');
          queryToggle.addEventListener('click', () => {
            const isHidden = queryBody.style.display === 'none';
            queryBody.style.display = isHidden ? '' : 'none';
            queryToggle.querySelector('.db-query-toggle-chevron').textContent = isHidden ? '▾' : '▸';
          });

          // Event listeners para el query bar
          const queryBar = columnsEl.querySelector('.db-query-bar');
          const opSelect = queryBar.querySelector('.db-query-op');
          const valInput = queryBar.querySelector('.db-query-val');
          const resultsDiv = columnsEl.querySelector('.db-query-results');

          // Ocultar input de valor para IS NULL / IS NOT NULL
          opSelect.addEventListener('change', () => {
            valInput.style.display = (opSelect.value === 'IS NULL' || opSelect.value === 'IS NOT NULL') ? 'none' : '';
          });

          // Buscar
          queryBar.querySelector('.db-query-run').addEventListener('click', () => {
            const col = queryBar.querySelector('.db-query-col').value;
            const op = opSelect.value;
            const val = valInput.value;
            dbRunQuery(tableName, col, op, val, 50, resultsDiv);
          });

          // Enter en el input
          valInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              const col = queryBar.querySelector('.db-query-col').value;
              const op = opSelect.value;
              dbRunQuery(tableName, col, op, valInput.value, 50, resultsDiv);
            }
          });

          // All rows
          queryBar.querySelector('.db-query-all').addEventListener('click', () => {
            dbRunQuery(tableName, '', '', '', 50, resultsDiv);
          });
        }
        columnsEl.dataset.loaded = 'true';
      }
    });
  });
}

async function dbRunQuery(tableName, column, operator, value, limit, resultsDiv) {
  resultsDiv.innerHTML = '<div class="db-col-loading">Querying...</div>';

  const result = await window.api.dbQuery(tableName, column, operator, value, limit);

  if (result.error) {
    resultsDiv.innerHTML = `
      <div class="db-error" style="font-size:11px">${escapeHtml(result.error)}</div>
      ${result.sql ? `<div class="db-query-sql">${escapeHtml(result.sql)}</div>` : ''}`;
    console.error(`[DB Query] ${tableName}:`, result.error);
    return;
  }

  if (!result.rows || result.rows.length === 0) {
    resultsDiv.innerHTML = `
      <div class="db-query-sql">${escapeHtml(result.sql)}</div>
      <div class="db-col-loading">No results</div>`;
    return;
  }

  // Detectar columna PK (buscar en el grupo padre)
  const group = resultsDiv.closest('.db-table-group');
  let pkColumn = null;
  if (group) {
    const pkEl = group.querySelector('.db-col-key');
    if (pkEl) {
      // Buscar la primera columna con 🔑
      group.querySelectorAll('.db-column').forEach((colEl) => {
        if (colEl.querySelector('.db-col-key').textContent.includes('🔑')) {
          pkColumn = colEl.querySelector('.db-col-name').textContent.trim();
        }
      });
    }
  }

  // Índice de la PK en las columnas del resultado
  const pkIndex = pkColumn ? result.columns.indexOf(pkColumn) : -1;

  let html = `<div class="db-query-sql">${escapeHtml(result.sql)}</div>
    <div class="db-query-info">${result.rows.length} row${result.rows.length !== 1 ? 's' : ''}${pkColumn ? ' — double-click cell to edit' : ''}</div>
    <div class="db-results-table-wrap">
    <table class="db-results-table" data-table="${escapeAttr(tableName)}" data-pk="${escapeAttr(pkColumn || '')}">
      <thead><tr>${result.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
      <tbody>`;

  for (const row of result.rows) {
    const pkVal = pkIndex >= 0 ? row[pkIndex] : null;
    html += `<tr data-pk-value="${escapeAttr(String(pkVal || ''))}">` + row.map((cell, ci) => {
      const colName = result.columns[ci];
      const isNull = cell === 'NULL' || cell === null || cell === undefined;
      const isPk = ci === pkIndex;
      const editable = pkColumn && !isPk;
      return `<td${isNull ? ' class="db-cell-null"' : ''}${editable ? ` class="db-cell-editable" data-col="${escapeAttr(colName)}"` : ''}>${isNull ? 'NULL' : escapeHtml(String(cell))}</td>`;
    }).join('') + '</tr>';
  }

  html += '</tbody></table></div>';
  resultsDiv.innerHTML = html;

  // Double-click para editar celdas
  if (pkColumn) {
    resultsDiv.querySelectorAll('.db-cell-editable').forEach((td) => {
      td.addEventListener('dblclick', () => dbStartCellEdit(td));
    });
  }
}

function dbStartCellEdit(td) {
  if (td.querySelector('input')) return; // Ya está editando

  const table = td.closest('table');
  const tableName = table.dataset.table;
  const pkColumn = table.dataset.pk;
  const pkValue = td.closest('tr').dataset.pkValue;
  const colName = td.dataset.col;
  const currentValue = td.classList.contains('db-cell-null') ? '' : td.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'db-cell-input';
  input.value = currentValue;
  input.placeholder = 'NULL';

  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  let saved = false;

  async function save() {
    if (saved) return;
    saved = true;

    const newValue = input.value;
    const isNull = newValue === '' || newValue === 'NULL';

    // Restaurar celda temporalmente
    td.textContent = isNull ? 'NULL' : newValue;
    td.className = isNull ? 'db-cell-null db-cell-editable' : 'db-cell-editable';
    td.dataset.col = colName;

    // Ejecutar UPDATE
    const result = await window.api.dbUpdate(
      tableName, pkColumn, pkValue, colName,
      isNull ? null : newValue
    );

    if (result.error) {
      td.textContent = currentValue || 'NULL';
      td.className = (currentValue === '' || currentValue === 'NULL') ? 'db-cell-null db-cell-editable' : 'db-cell-editable';
      td.dataset.col = colName;
      console.error('[DB Update]', result.error);
      alert(`Update failed:\n${result.error}`);
    } else {
      // Flash verde para confirmar
      td.classList.add('db-cell-saved');
      setTimeout(() => td.classList.remove('db-cell-saved'), 800);
    }

    // Re-attach double click
    td.addEventListener('dblclick', () => dbStartCellEdit(td));
  }

  function cancel() {
    if (saved) return;
    saved = true;
    td.textContent = currentValue || 'NULL';
    td.className = (currentValue === '' || !currentValue) ? 'db-cell-null db-cell-editable' : 'db-cell-editable';
    td.dataset.col = colName;
    td.addEventListener('dblclick', () => dbStartCellEdit(td));
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  input.addEventListener('blur', () => {
    // Pequeño delay para que Enter se procese antes que blur
    setTimeout(() => { if (!saved) save(); }, 100);
  });
}

// ┌──────────────────────────────────────────────────┐
// │  9c2. LARAVEL ROUTE LIST                          │
// │  Panel formateado con rutas, métodos, controllers │
// │  y click para abrir el controller.               │
// └──────────────────────────────────────────────────┘

async function openRouteList() {
  const tabPath = '__route-list__';
  const existing = state.openTabs.find((t) => t.path === tabPath);
  if (existing) {
    activateTab(existing);
    loadRouteList();
    return;
  }

  const tab = { path: tabPath, name: 'Routes', model: null, language: 'routes', modified: false };
  state.openTabs.push(tab);
  activateTab(tab);
  loadRouteList();
}

async function loadRouteList() {
  const container = document.getElementById('route-list-container');
  container.innerHTML = '<div class="db-loading">Loading routes...</div>';

  const result = await window.api.laravelRouteList();
  if (result.error) {
    const detail = [result.error, result.output].filter(Boolean).join('\n\n');
    container.innerHTML = `
      <div class="db-error">Failed to load routes</div>
      <pre class="route-raw-output">${escapeHtml(detail)}</pre>`;
    console.error('[Route List]', detail);
    return;
  }

  let routes;
  try {
    routes = JSON.parse(result.output);
  } catch (parseErr) {
    const detail = [
      `JSON parse error: ${parseErr.message}`,
      result.output ? `stdout:\n${result.output}` : null,
      result.error ? `stderr:\n${result.error}` : null,
    ].filter(Boolean).join('\n\n');
    container.innerHTML = `
      <div class="db-error">Failed to parse route list. Make sure your Laravel app can boot.</div>
      <pre class="route-raw-output">${escapeHtml(detail)}</pre>`;
    console.error('[Route List]', detail);
    return;
  }

  if (!routes.length) {
    container.innerHTML = '<div class="db-loading">No routes defined</div>';
    return;
  }

  const methodColors = {
    GET: 'route-method-get',
    POST: 'route-method-post',
    PUT: 'route-method-put',
    PATCH: 'route-method-patch',
    DELETE: 'route-method-delete',
  };

  let html = `
    <div class="route-header">
      <span class="route-header-count">${routes.length} routes</span>
    </div>
    <div class="route-table">
      <div class="route-table-head">
        <span class="route-col-method">Method</span>
        <span class="route-col-uri">URI</span>
        <span class="route-col-name">Name</span>
        <span class="route-col-action">Action</span>
      </div>`;

  for (const route of routes) {
    const methods = (route.method || '').split('|');
    const methodBadges = methods.map((m) =>
      `<span class="route-method-badge ${methodColors[m] || ''}">${escapeHtml(m)}</span>`
    ).join('');

    const action = route.action || '';
    const isController = action.includes('@') || action.includes('Controller');

    html += `
      <div class="route-row${isController ? ' route-clickable' : ''}" ${isController ? `data-action="${escapeAttr(action)}"` : ''}>
        <span class="route-col-method">${methodBadges}</span>
        <span class="route-col-uri">${escapeHtml(route.uri || '')}</span>
        <span class="route-col-name">${escapeHtml(route.name || '')}</span>
        <span class="route-col-action">${escapeHtml(action)}</span>
      </div>`;
  }

  html += '</div>';
  container.innerHTML = html;

  // Click en controller → buscar y abrir archivo
  container.querySelectorAll('.route-clickable').forEach((row) => {
    row.addEventListener('click', () => {
      const action = row.dataset.action;
      if (!action || !state.currentFolder) return;

      // Extraer el namespace del controller: App\Http\Controllers\UserController@index
      let controllerClass = action.split('@')[0];
      // Convertir namespace a path: App\Http\Controllers\UserController → app/Http/Controllers/UserController.php
      const filePath = controllerClass.replace(/\\/g, '/') + '.php';
      // Intentar con app/ (PSR-4 standard Laravel)
      const fullPath = state.currentFolder + '/' + filePath.replace(/^App\//, 'app/');

      const fileName = fullPath.split(/[/\\]/).pop();
      openFile(fullPath, fileName);
    });
  });
}

function initDbAndRoutes() {
  window.api.onMenuDbViewer(() => openDbViewer());
  window.api.onMenuRouteList(() => openRouteList());
  document.getElementById('btn-open-db').addEventListener('click', () => openDbViewer());
  document.getElementById('btn-open-routes').addEventListener('click', () => openRouteList());
}

// ┌──────────────────────────────────────────────────┐
// │  9c3. PHP FORMAT ON SAVE & PHPUNIT                │
// │  Toggle de format on save desde menú nativo y    │
// │  ejecución de tests PHPUnit desde el menú.       │
// └──────────────────────────────────────────────────┘

function initPhpTools() {
  // Format on save: escuchar cambios desde el menú nativo
  window.api.onFormatOnSaveChanged((enabled) => {
    state.formatOnSave = enabled;
  });

  // PHPUnit: Run All Tests
  window.api.onPhpunitRunAll(async () => {
    showCommandOutput('Running: PHPUnit (all tests)', 'Executing...', null, 0);
    const result = await window.api.phpunitRun([]);
    showCommandOutput(
      '$ vendor/bin/phpunit',
      result.output || '',
      result.error || '',
      result.code
    );
  });

  // PHPUnit: Run Current File
  window.api.onPhpunitRunFile(async () => {
    if (!state.activeTab || !state.activeTab.path || state.activeTab.path.startsWith('__')) {
      alert('No PHP file is open');
      return;
    }
    const filePath = state.activeTab.path;
    showCommandOutput(`Running: PHPUnit (${filePath.split(/[/\\]/).pop()})`, 'Executing...', null, 0);
    const result = await window.api.phpunitRun([filePath]);
    showCommandOutput(
      `$ vendor/bin/phpunit ${filePath.split(/[/\\]/).pop()}`,
      result.output || '',
      result.error || '',
      result.code
    );
  });

  // PHPUnit: Run Current Method
  window.api.onPhpunitRunMethod(async () => {
    if (!state.activeTab || !state.activeTab.model || state.activeTab.path.startsWith('__')) {
      alert('No PHP file is open');
      return;
    }

    const filePath = state.activeTab.path;
    const position = state.editor.getPosition();
    const content = state.activeTab.model.getValue();
    const lines = content.split('\n');

    // Buscar el método de test más cercano arriba del cursor
    let methodName = null;
    for (let i = position.lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      // Match: public function test_something( o function testSomething(
      const match = line.match(/function\s+(test\w+)\s*\(/);
      if (match) {
        methodName = match[1];
        break;
      }
      // Match: /** @test */ encima de un método
      if (line.match(/@test/)) {
        // Buscar el siguiente function
        for (let j = i + 1; j < lines.length; j++) {
          const fnMatch = lines[j].match(/function\s+(\w+)\s*\(/);
          if (fnMatch) {
            methodName = fnMatch[1];
            break;
          }
        }
        if (methodName) break;
      }
    }

    if (!methodName) {
      alert('No test method found at cursor position');
      return;
    }

    showCommandOutput(`Running: PHPUnit --filter ${methodName}`, 'Executing...', null, 0);
    const result = await window.api.phpunitRun([filePath, '--filter', methodName]);
    showCommandOutput(
      `$ vendor/bin/phpunit --filter ${methodName}`,
      result.output || '',
      result.error || '',
      result.code
    );
  });
}

// ┌──────────────────────────────────────────────────┐
// │  9d. SYSTEM MONITOR                              │
// │  Muestra uso de RAM y CPU en el status bar.      │
// └──────────────────────────────────────────────────┘
function initSystemMonitor() {
  const memEl = document.getElementById('status-memory');
  const cpuEl = document.getElementById('status-cpu');

  function updateMem() {
    const mem = window.api.getMemoryUsage();
    const mb = (mem.rss / 1024 / 1024).toFixed(0);
    memEl.textContent = `RAM: ${mb} MB`;
  }

  async function updateCpu() {
    const percent = await window.api.getCpuUsage();
    cpuEl.textContent = `CPU: ${percent}%`;
  }

  updateMem();
  updateCpu();
  setInterval(() => { updateMem(); updateCpu(); }, 3000);
}

(function init() {
  initEditor();
  initThemeMenu();
  initSidebarSections();
  initEventListeners();
  initGitPanel();
  initErrorLog();
  initTerminal(); // async, no bloqueante
  initQuickOpen();
  initSearchPanel();
  initSymbolSearch();
  initComposerArtisan();
  initPhpTools();
  initDbAndRoutes();
  initSystemMonitor();
})();
