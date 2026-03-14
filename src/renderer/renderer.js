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
 * 3. File Tree — explorador de archivos
 * 4. Tab Manager — pestañas abiertas
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
  sidebarView: 'explorer',   // 'explorer' | 'git'
  gitRefreshTimer: null,
  editor: null,                // Instancia de Monaco
  terminal: null,              // Instancia de xterm.js
  terminalFitAddon: null,
  terminalResizeObserver: null, // ResizeObserver del terminal container
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
}

function activateTab(tab) {
  state.activeTab = tab;
  document.getElementById('welcome').style.display = 'none';

  const isTerminal = tab.path === '__terminal__';
  const isGitGraph = tab.path === '__git-graph__';
  const isDiff = tab.path.startsWith('__diff__');
  const isErrorLog = tab.path === '__errorlog__';

  // Mostrar solo el container correcto
  const isEditor = !isTerminal && !isGitGraph && !isDiff && !isErrorLog;
  document.getElementById('editor-container').style.display = isEditor ? 'block' : 'none';
  document.getElementById('terminal-container').style.display = isTerminal ? 'block' : 'none';
  document.getElementById('git-graph-container').style.display = isGitGraph ? 'block' : 'none';
  document.getElementById('diff-container').style.display = isDiff ? 'block' : 'none';
  document.getElementById('errorlog-container').style.display = isErrorLog ? 'flex' : 'none';

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
    }
  } else if (isErrorLog) {
    document.getElementById('status-language').textContent = 'Error Log';
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

  // Limpiar diff editor si aplica
  if (tab.diffEditor) {
    if (tab.diffModels) {
      tab.diffModels.forEach((m) => m.dispose());
    }
    tab.diffEditor.dispose();
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

  // Limpiar container y crear diff editor
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

function showExplorerPanel() {
  state.sidebarView = 'explorer';
  document.getElementById('explorer-sections').style.display = '';
  document.getElementById('git-panel').style.display = 'none';
  document.getElementById('sidebar-header').querySelector('span').textContent =
    state.currentFolder
      ? state.currentFolder.split(/[/\\]/).pop().toUpperCase()
      : 'EXPLORER';
  document.getElementById('btn-toggle-git').style.background = '';
  if (state.gitRefreshTimer) {
    clearInterval(state.gitRefreshTimer);
    state.gitRefreshTimer = null;
  }
}

function showGitPanel() {
  state.sidebarView = 'git';
  document.getElementById('explorer-sections').style.display = 'none';
  document.getElementById('git-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent =
    'SOURCE CONTROL';
  document.getElementById('btn-toggle-git').style.background = 'var(--bg-hover)';
  refreshGitStatus();
  // Auto-refresh cada 5 segundos mientras el panel está visible
  state.gitRefreshTimer = setInterval(refreshGitStatus, 5000);
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

  renderGitFileList('git-staged-list', 'git-staged-count', files.staged, 'staged');
  renderGitFileList('git-unstaged-list', 'git-unstaged-count', files.unstaged, 'unstaged');
  renderGitFileList('git-untracked-list', 'git-untracked-count', files.untracked, 'untracked');
}

function renderGitFileList(listId, countId, files, type) {
  const listEl = document.getElementById(listId);
  const countEl = document.getElementById(countId);
  countEl.textContent = files.length;
  listEl.innerHTML = '';

  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'git-file-item';

    const fileName = file.path.split(/[/\\]/).pop();
    const statusClass = `git-status-${file.status}`;
    const statusLabel = file.status[0].toUpperCase();

    let actions = '';
    if (type === 'staged') {
      actions = `<div class="git-file-actions">
        <button class="git-action-unstage" data-path="${file.path}" title="Unstage">−</button>
      </div>`;
    } else if (type === 'unstaged') {
      actions = `<div class="git-file-actions">
        <button class="git-action-stage" data-path="${file.path}" title="Stage">+</button>
        <button class="git-action-discard" data-path="${file.path}" title="Discard changes">↺</button>
      </div>`;
    } else {
      actions = `<div class="git-file-actions">
        <button class="git-action-stage" data-path="${file.path}" title="Stage">+</button>
      </div>`;
    }

    const deletedClass = file.status === 'deleted' ? ' git-file-deleted' : '';
    item.innerHTML = `
      <span class="git-file-name${deletedClass}" title="${file.path}">${fileName}</span>
      <span class="git-file-status ${statusClass}">${statusLabel}</span>
      ${actions}`;

    // Click en el nombre abre diff view (o archivo normal si es untracked)
    item.querySelector('.git-file-name').addEventListener('click', () => {
      if (file.status === 'deleted') {
        console.warn('Cannot open deleted file:', file.path);
        return;
      }
      if (type === 'untracked') {
        openFile(file.absolutePath, fileName);
      } else {
        openDiffView(file.path, file.absolutePath, fileName, type === 'staged');
      }
    });

    listEl.appendChild(item);
  }

  // Event delegation para las acciones (evita leak de listeners en cada refresh)
  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-path]');
    if (!btn) return;
    e.stopPropagation();
    const filePath = btn.dataset.path;

    if (btn.classList.contains('git-action-stage')) {
      await window.api.gitAdd(state.currentFolder, [filePath]);
      refreshGitStatus();
    } else if (btn.classList.contains('git-action-unstage')) {
      await window.api.gitUnstage(state.currentFolder, [filePath]);
      refreshGitStatus();
    } else if (btn.classList.contains('git-action-discard')) {
      if (confirm(`Discard changes to ${filePath}?`)) {
        await window.api.gitDiscard(state.currentFolder, filePath);
        refreshGitStatus();
      }
    }
  });
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

function initGitPanel() {
  // Sección collapse/expand
  document.querySelectorAll('.git-section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const chevron = header.querySelector('.git-section-chevron');
      const list = header.nextElementSibling;
      chevron.classList.toggle('collapsed');
      list.classList.toggle('collapsed');
    });
  });

  // Commit
  document.getElementById('git-commit-btn').addEventListener('click', gitCommit);
  document.getElementById('git-commit-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gitCommit();
  });

  // Git graph — abrir como tab
  document.getElementById('btn-git-graph')?.addEventListener('click', () => {
    openGitGraph();
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
// │  9b. INIT — ARRANQUE DE LA APLICACIÓN            │
// │  Inicializa todos los subsistemas en orden:      │
// │  editor, tema, sidebar, eventos, git, terminal,  │
// │  quick open, y monitor de recursos (RAM/CPU).    │
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
  initSystemMonitor();
})();
