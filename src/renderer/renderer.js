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
  editor: null,                // Instancia de Monaco (pane izquierdo)
  // ── Multi-terminal ──
  terminals: new Map(),        // Map<id, { xterm, fitAddon, resizeObserver, ptyId, el }>
  activeTerminalId: null,      // ID de la terminal activa
  terminalNextId: 1,           // Counter local para naming
  formatOnSave: false,         // PHP format on save (desactivado por defecto)
  autoSave: false,             // Auto-save (desactivado por defecto)
  autoSaveTimer: null,         // Timer del debounce de auto-save
  zoom: {
    fontSize: 14,              // Tamaño actual — se restaura desde localStorage al arrancar
    defaultFontSize: 14,       // Referencia para calcular el % del indicador
    min: 8,
    max: 40,
    step: 1,
  },
  // ── Split editor ─────────────────────────────────────────────
  split: false,                // Split activo o no
  editorRight: null,           // Monaco del pane derecho (creado lazy)
  openTabsRight: [],           // Tabs del pane derecho
  activeTabRight: null,        // Tab activo en pane derecho
  activePaneRight: false,      // true = foco en el pane derecho
  // ── Project capabilities ─────────────────────────────────────
  projectCaps: {},             // { hasComposer, hasArtisan, hasPint, hasPhpUnit, ... }
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
      { token: 'variable', foreground: 'C792EA' },
      { token: 'constant', foreground: 'F7A73E', fontStyle: 'bold' },
      { token: 'tag', foreground: '3fb950' },
      { token: 'tag.html', foreground: '3fb950' },
      { token: 'delimiter.html', foreground: '6B87A8' },
      { token: 'attribute.name', foreground: '247D9D' },
      { token: 'attribute.name.html', foreground: '247D9D' },
      { token: 'attribute.value', foreground: 'F1D7BA' },
      { token: 'attribute.value.html', foreground: 'F1D7BA' },
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
      { token: 'variable', foreground: '7C3AED' },
      { token: 'constant', foreground: 'c88520', fontStyle: 'bold' },
      { token: 'tag', foreground: '2d8a3e' },
      { token: 'tag.html', foreground: '2d8a3e' },
      { token: 'delimiter.html', foreground: '6B87A8' },
      { token: 'attribute.name', foreground: '247D9D' },
      { token: 'attribute.name.html', foreground: '247D9D' },
      { token: 'attribute.value', foreground: '1a8a72' },
      { token: 'attribute.value.html', foreground: '1a8a72' },
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

  // ── Habilitar JSX/TSX en los lenguajes JS/TS de Monaco ──
  // Sin esto, Monaco trata <div> como operadores < y > en vez de tags JSX.
  const jsxOpts = {
    jsx: monaco.languages.typescript.JsxEmit.React,
    allowJs: true,
    allowNonTsExtensions: true,
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
  };
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(jsxOpts);
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(jsxOpts);

  // Desactivar diagnósticos built-in de Monaco (usamos los del TS LSP externo)
  // pero mantener el semantic tokens provider activo para colorear JSX
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });

  // Sincronizar modelos automáticamente para que el TS worker los analice
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);

  // Crear la instancia del editor
  state.editor = monaco.editor.create(
    document.getElementById('editor-container'),
    {
      theme: 'mojavecode-php-dark',
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 14,
      lineHeight: 22,
      glyphMargin: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      'semanticHighlighting.enabled': true,
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

  // Escuchar cambios de posición del cursor → actualizar status bar + blame
  state.editor.onDidChangeCursorPosition((e) => {
    document.getElementById('status-cursor').textContent =
      `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    scheduleBlameUpdate(e.position.lineNumber);
  });

  // Escuchar cambios en el contenido → marcar tab como modified + actualizar outline + model highlights
  let outlineTimer = null;
  let modelHighlightTimer = null;
  state.editor.onDidChangeModelContent(() => {
    if (state.activeTab && !state.activeTab.modified) {
      state.activeTab.modified = true;
      renderTabs();
    }
    // Debounce outline update
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(updateOutline, 500);
    // Debounce model/method highlight
    if (state.activeTab && state.activeTab.language === 'php') {
      clearTimeout(modelHighlightTimer);
      modelHighlightTimer = setTimeout(highlightModelCalls, 300);
    }
    // Auto-save: si está activado (File > Auto Save), esperamos 1 segundo
    // después del último cambio para guardar. El clearTimeout hace que
    // si el usuario sigue escribiendo, el timer se reinicie cada vez
    // (debounce), así no guardamos en medio de una edición rápida.
    if (state.autoSave && state.activeTab?.model) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = setTimeout(() => saveCurrentFile(), 1000);
    }
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

  // Keybinding: Cmd+Shift+P → Command Palette (interceptar antes que Monaco)
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
    () => toggleCommandPalette()
  );

  // Keybinding: Cmd+W → cerrar tab activo
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
    () => { if (state.activeTab) closeTab(state.activeTab.path); }
  );

  // Cmd+F: Find in file (Monaco built-in) o filter en Routes
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
    () => {
      if (state.activeTab?.path === '__route-list__') {
        const rc = document.getElementById('route-list-container');
        if (rc?._showRouteSearch) rc._showRouteSearch();
        return;
      }
      if (state.activeTab?.path === '__db-viewer__') {
        const dc = document.getElementById('db-viewer-container');
        if (dc?._showDbSearch) dc._showDbSearch();
        return;
      }
      state.editor.getAction('actions.find').run();
    }
  );

  // Cmd+H: Find & Replace (Monaco built-in)
  state.editor.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
    () => state.editor.getAction('editor.action.startFindReplaceAction').run()
  );

  // Zoom — addAction (no addCommand) para no cancelar promesas internas de Monaco
  state.editor.addAction({
    id: 'mojavecode.zoomIn',
    label: 'Zoom In',
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal,
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Equal, // Cmd+Shift+= (teclados donde + requiere Shift)
    ],
    run: () => editorZoomIn(),
  });

  state.editor.addAction({
    id: 'mojavecode.zoomOut',
    label: 'Zoom Out',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus],
    run: () => editorZoomOut(),
  });

  state.editor.addAction({
    id: 'mojavecode.zoomReset',
    label: 'Reset Zoom',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Digit0],
    run: () => editorZoomReset(),
  });

  // UI Zoom (sidebar, file tree, debug panel) — handled by global keydown listener
  // Registered as editor actions for Command Palette access only (no keybindings to avoid conflicts)
  state.editor.addAction({ id: 'mojavecode.uiZoomIn',    label: 'UI Zoom In (Sidebar/Panels)',    run: () => uiZoomIn() });
  state.editor.addAction({ id: 'mojavecode.uiZoomOut',   label: 'UI Zoom Out (Sidebar/Panels)',   run: () => uiZoomOut() });
  state.editor.addAction({ id: 'mojavecode.uiZoomReset', label: 'UI Zoom Reset (Sidebar/Panels)', run: () => uiZoomReset() });

  // Restaurar zoom guardado en localStorage
  const savedSize = parseInt(localStorage.getItem('mojavecode-zoom-fontSize'), 10);
  if (savedSize >= state.zoom.min && savedSize <= state.zoom.max) {
    applyZoom(savedSize);
  }
  updateZoomIndicator();

  // Mostrar welcome screen (el editor se oculta hasta abrir un archivo)
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('editor-container').style.display = 'none';
}

// ┌──────────────────────────────────────────────────┐
// │  1b. ZOOM                                        │
// │  Ajusta fontSize y lineHeight del editor.        │
// │  Persiste en localStorage y refleja el % en      │
// │  la status bar (click para resetear).             │
// └──────────────────────────────────────────────────┘
function applyZoom(size) {
  const z = state.zoom;
  const clamped = Math.max(z.min, Math.min(size, z.max));
  if (clamped === z.fontSize) return;
  z.fontSize = clamped;
  // lineHeight proporcional: ratio 22/14 ≈ 1.57 del default
  const lineHeight = Math.round(clamped * (22 / 14));
  state.editor.updateOptions({ fontSize: clamped, lineHeight });
  // Sincronizar zoom con el pane derecho si el split está activo
  if (state.editorRight) state.editorRight.updateOptions({ fontSize: clamped, lineHeight });
  // Escalar tabs especiales (rutas, database, error log) proporcionalmente
  const specialZoom = clamped / z.defaultFontSize;
  document.documentElement.style.setProperty('--special-tab-zoom', specialZoom);
  localStorage.setItem('mojavecode-zoom-fontSize', clamped);
  updateZoomIndicator();
}

function editorZoomIn()    { applyZoom(state.zoom.fontSize + state.zoom.step); }
function editorZoomOut()   { applyZoom(state.zoom.fontSize - state.zoom.step); }
function editorZoomReset() {
  state.zoom.fontSize = state.zoom.defaultFontSize + 1; // forzar que applyZoom actualice
  applyZoom(state.zoom.defaultFontSize);
  localStorage.removeItem('mojavecode-zoom-fontSize');
}

function updateZoomIndicator() {
  const pct = Math.round((state.zoom.fontSize / state.zoom.defaultFontSize) * 100);
  document.getElementById('status-zoom').textContent = `${pct}%`;
}

// ┌──────────────────────────────────────────────────┐
// │  1c. UI ZOOM (sidebar, file tree, debug panel)   │
// │  Ajusta --ui-font-size para escalar paneles      │
// │  laterales. Independiente del zoom del editor.    │
// └──────────────────────────────────────────────────┘
state.uiZoom = {
  level: parseFloat(localStorage.getItem('mojavecode-ui-zoom') || '1'),
  default: 1,
  min: 0.75,
  max: 1.75,
  step: 0.05,
};

// Restaurar UI zoom guardado
(function restoreUiZoom() {
  document.documentElement.style.setProperty('--ui-zoom', state.uiZoom.level);
})();

function applyUiZoom(level) {
  const clamped = Math.max(state.uiZoom.min, Math.min(parseFloat(level.toFixed(2)), state.uiZoom.max));
  if (clamped === state.uiZoom.level) return;
  state.uiZoom.level = clamped;
  document.documentElement.style.setProperty('--ui-zoom', clamped);
  localStorage.setItem('mojavecode-ui-zoom', clamped);
}

function uiZoomIn()    { applyUiZoom(state.uiZoom.level + state.uiZoom.step); }
function uiZoomOut()   { applyUiZoom(state.uiZoom.level - state.uiZoom.step); }
function uiZoomReset() {
  state.uiZoom.level = state.uiZoom.default + 0.01;
  applyUiZoom(state.uiZoom.default);
  localStorage.removeItem('mojavecode-ui-zoom');
}

// ┌──────────────────────────────────────────────────┐
// │  1b. GIT BLAME INLINE                            │
// │  Muestra autor, fecha y mensaje del commit que   │
// │  modificó la línea actual. Se actualiza con      │
// │  debounce al mover el cursor. La info aparece    │
// │  como decoración sutil al final de la línea y    │
// │  también en el status bar inferior.              │
// └──────────────────────────────────────────────────┘
let _blameTimer = null;
let _blameDecorations = [];
let _lastBlameLine = -1;

/**
 * Programa una actualización de blame con debounce de 300ms.
 * Evita llamar a git blame en cada movimiento de cursor.
 *
 * @param {number} lineNumber - Línea actual del cursor
 */
function scheduleBlameUpdate(lineNumber) {
  if (_blameTimer) clearTimeout(_blameTimer);
  if (lineNumber === _lastBlameLine) return;
  _blameTimer = setTimeout(() => fetchBlame(lineNumber), 300);
}

/**
 * Obtiene la info de blame para una línea y la muestra como
 * decoración inline (after text) y en el status bar.
 *
 * Solo funciona con archivos reales de un repo git (no tabs
 * especiales como terminal, diff, etc.).
 *
 * @param {number} lineNumber - Línea para la que obtener blame
 */
async function fetchBlame(lineNumber) {
  const tab = state.activeTab;
  const blameEl = document.getElementById('status-blame');

  // Solo para archivos reales en un repo git
  if (!tab || !state.currentFolder || tab.path.startsWith('__')) {
    clearBlame();
    return;
  }

  // Obtener path relativo al repo
  const repoRoot = state.gitRepoRoot || state.currentFolder;
  let relativePath = tab.path;
  if (tab.path.startsWith(repoRoot)) {
    relativePath = tab.path.substring(repoRoot.length).replace(/^[/\\]/, '');
  }

  const result = await window.api.gitBlame(state.currentFolder, relativePath, lineNumber);

  // Verificar que el cursor no se movió mientras esperábamos la respuesta
  const currentLine = state.editor.getPosition()?.lineNumber;
  if (currentLine !== lineNumber) return;

  if (result.error || !result.author) {
    clearBlame();
    return;
  }

  _lastBlameLine = lineNumber;

  // ── Decoración inline (after text, sutil) ──────────────────
  const blameText = `${result.author}, ${result.date} — ${result.summary}`;
  _blameDecorations = state.editor.deltaDecorations(_blameDecorations, [
    {
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        after: {
          content: `    ${blameText}`,
          inlineClassName: 'blame-inline-decoration',
        },
        isWholeLine: true,
      },
    },
  ]);

  // ── Status bar ─────────────────────────────────────────────
  if (blameEl) {
    blameEl.textContent = `${result.shortHash} ${result.author}, ${result.date} — ${result.summary}`;
    blameEl.title = `${result.hash}\n${result.author}, ${result.date}\n${result.summary}`;
  }
}

/**
 * Limpia la decoración de blame y el status bar.
 */
function clearBlame() {
  _lastBlameLine = -1;
  if (state.editor && _blameDecorations.length) {
    _blameDecorations = state.editor.deltaDecorations(_blameDecorations, []);
  }
  const blameEl = document.getElementById('status-blame');
  if (blameEl) { blameEl.textContent = ''; blameEl.title = ''; }
}

// ┌──────────────────────────────────────────────────┐
// │  1c. RENAME SYMBOL NOTIFICATION                  │
// │  Muestra un toast temporal con la info del       │
// │  refactor después de un rename exitoso.          │
// └──────────────────────────────────────────────────┘

/**
 * Muestra una notificación temporal (toast) informando el resultado
 * de un rename/refactor: cuántos archivos y ocurrencias se afectaron.
 *
 * @param {number} fileCount - Cantidad de archivos modificados
 * @param {number} editCount - Cantidad total de ocurrencias renombradas
 * @param {string} newName - Nuevo nombre del símbolo
 */
function showRenameInfo(fileCount, editCount, newName) {
  // Remover toast anterior si existe
  const existing = document.getElementById('rename-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'rename-toast';
  toast.className = 'rename-toast';
  toast.innerHTML = `
    <span class="rename-toast-icon">✎</span>
    <span>Renamed to <strong>${escapeHtml(newName)}</strong> — ${editCount} occurrence${editCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}</span>
  `;
  document.body.appendChild(toast);

  // Auto-remove después de 4 segundos
  setTimeout(() => toast.classList.add('rename-toast-fade'), 3500);
  setTimeout(() => toast.remove(), 4000);
}

// ┌──────────────────────────────────────────────────┐
// │  1d. GIT BRANCH AUTO-REFRESH                     │
// │  Detecta cambios de rama desde la terminal.      │
// │                                                  │
// │  Cuando el usuario ejecuta comandos en la        │
// │  terminal (ej: git checkout, git switch), la     │
// │  data del pty dispara un check con debounce.     │
// │  Si la rama cambió, actualiza el status bar y    │
// │  refresca el panel de git para mantener la UI    │
// │  sincronizada con el estado real del repo.       │
// └──────────────────────────────────────────────────┘
let _gitBranchRefreshTimer = null;
let _lastKnownBranch = null;

function scheduleGitBranchRefresh() {
  if (!state.currentFolder) return;

  // Cancelar check previo si el usuario sigue escribiendo/ejecutando
  if (_gitBranchRefreshTimer) clearTimeout(_gitBranchRefreshTimer);

  // Esperar 500ms de "silencio" antes de consultar la rama.
  // Esto evita hacer decenas de llamadas git mientras la terminal
  // está imprimiendo output de un comando largo (npm install, etc.)
  _gitBranchRefreshTimer = setTimeout(async () => {
    _gitBranchRefreshTimer = null;

    const result = await window.api.gitBranch(state.currentFolder);
    if (result.error) return;

    const branch = result.output;

    // Solo actualizar la UI si la rama realmente cambió.
    // Sin este guard, cada Enter en la terminal provocaría
    // un repaint innecesario del status bar y del git panel.
    if (branch !== _lastKnownBranch) {
      _lastKnownBranch = branch;
      document.getElementById('status-branch').textContent = `⎇ ${branch}`;
      if (typeof refreshGitStatus === 'function') refreshGitStatus();
    }
  }, 500);
}

/**
 * Actualiza el badge de entorno Docker en el status bar.
 *
 * Muestra tres estados:
 *  • ⛵ SAIL   — proyecto con Sail activo (fondo azul claro)
 *  • 🐳 DOCKER — proyecto con Docker exec genérico (fondo azul Docker)
 *  • oculto    — ejecución local sin contenedor
 *
 * @param {object} caps - projectCapabilities enviado por el main process
 */
function updateDockerEnvBadge(caps) {
  const el = document.getElementById('status-docker-env');
  if (!el) return;

  const isSail   = caps.hasSail && caps.sailEnabled;
  const isDocker = !isSail && caps.hasDocker && caps.dockerContainer;

  if (isSail) {
    el.textContent = '⛵ SAIL';
    el.className = 'env-sail';
    el.title = 'Laravel Sail active — Artisan & Composer run inside Docker';
    el.style.display = 'flex';
  } else if (isDocker) {
    el.textContent = `🐳 ${caps.dockerContainer}`;
    el.className = 'env-docker';
    el.title = `Docker exec active — container: ${caps.dockerContainer}\nworkdir: ${caps.dockerWorkdir}`;
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
    el.className = '';
  }
}

/**
 * Muestra el banner informativo de Docker la primera vez que se abre
 * un proyecto con contenedor activo.
 *
 * El banner explica que Artisan y Composer se ejecutan dentro del
 * contenedor, y ofrece un checkbox "Don't show again" que persiste
 * en localStorage. Se oculta al hacer click en "Got it".
 *
 * @param {object} caps - projectCapabilities del main process
 */
function showDockerNoticeIfNeeded(caps) {
  const isDocker = (caps.hasSail && caps.sailEnabled) || (caps.hasDocker && caps.dockerContainer);
  const banner = document.getElementById('docker-notice');
  if (!banner) return;

  // Ocultar siempre primero — puede que el nuevo proyecto no sea Docker
  banner.style.display = 'none';

  if (!isDocker) return;
  if (localStorage.getItem('mojavecode-docker-notice-dismissed') === '1') return;

  // Armar el texto según el tipo de entorno
  const envName = (caps.hasSail && caps.sailEnabled)
    ? '⛵ Laravel Sail'
    : `🐳 <strong>${caps.dockerContainer}</strong>`;

  document.getElementById('docker-notice-text').innerHTML =
    `Artisan &amp; Composer commands run <strong>inside the Docker container</strong> (${envName}). `
    + `Make sure it's running before executing commands.`;

  document.getElementById('docker-notice-dismiss').checked = false;
  banner.style.display = 'flex';

  document.getElementById('docker-notice-ok').onclick = () => {
    if (document.getElementById('docker-notice-dismiss').checked) {
      localStorage.setItem('mojavecode-docker-notice-dismissed', '1');
    }
    banner.style.display = 'none';
  };
}

// ┌──────────────────────────────────────────────────┐
// │  2. TERMINAL                                     │
// │  Emulador xterm.js conectado a un pty real       │
// │  (node-pty) via IPC. Incluye FitAddon para       │
// │  auto-resize, WebLinksAddon para URLs, y manejo  │
// │  bidireccional de datos (input/output).           │
// └──────────────────────────────────────────────────┘
// ────────────────────────────────────────────────────────────────
// 2. MULTI-TERMINAL
// ────────────────────────────────────────────────────────────────
//
// Cada terminal es una instancia independiente de xterm.js + pty.
// Las terminales se muestran dentro del tab especial __terminal__
// con su propia barra de tabs interna. El estado se mantiene en
// state.terminals (Map<localId, termInfo>).

/**
 * Retorna el tema de colores para una nueva instancia de xterm.js.
 * Usa el tema custom activo si existe, o el tema Mojave Dark por defecto.
 */
function getTerminalThemeColors() {
  const customThemes = typeof getCustomThemes === 'function' ? getCustomThemes() : [];
  const currentThemeName = localStorage.getItem('mojavecode-php-theme') || 'dark';
  const custom = customThemes.find(t => t.id === currentThemeName);
  if (custom && typeof generateTerminalTheme === 'function') {
    return generateTerminalTheme(custom);
  }
  return {
    background: '#0a1420', foreground: '#F4E2CE', cursor: '#E85324',
    cursorAccent: '#0a1420', selectionBackground: '#26476980',
    black: '#0d1a2a', red: '#EA6E40', green: '#3fb950', yellow: '#F7A73E',
    blue: '#247D9D', magenta: '#C4A882', cyan: '#2dd4bf', white: '#F4E2CE',
    brightBlack: '#6B87A8', brightRed: '#F5663C', brightGreen: '#3fb950',
    brightYellow: '#F5B25C', brightBlue: '#2dd4bf', brightMagenta: '#F1D7BA',
    brightCyan: '#2dd4bf', brightWhite: '#FEFAF7',
  };
}

/**
 * Crea una nueva instancia de terminal (xterm.js + pty).
 * La agrega al DOM, conecta el pty, y la activa.
 *
 * @param {string} [cwd] - Directorio de trabajo (default: project root)
 * @returns {number} ID local de la terminal creada
 */
async function createTerminalInstance(cwd) {
  const Terminal = globalThis.Terminal;
  const FitAddon = window.FitAddon?.FitAddon;
  const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon;

  const localId = state.terminalNextId++;

  // Crear el DOM container para esta instancia
  const el = document.createElement('div');
  el.className = 'terminal-instance';
  el.id = `terminal-inst-${localId}`;
  document.getElementById('terminal-instances').appendChild(el);

  // Crear xterm.js
  const xterm = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    lineHeight: 1.5,
    theme: getTerminalThemeColors(),
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
  });

  let fitAddon = null;
  if (FitAddon) {
    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
  }
  if (WebLinksAddon) {
    xterm.loadAddon(new WebLinksAddon());
  }

  xterm.open(el);
  if (fitAddon) setTimeout(() => fitAddon.fit(), 100);

  // Spawn pty
  const result = await window.api.ptySpawn(cwd || state.currentFolder || undefined);
  if (result.error) {
    xterm.writeln(`\x1b[31mTerminal error: ${result.error}\x1b[0m`);
    xterm.writeln('Install node-pty: npm rebuild node-pty');
  }

  const ptyId = result.id || null;

  // xterm → pty
  xterm.onData((data) => {
    if (ptyId) window.api.ptyWrite(ptyId, data);
  });

  // ResizeObserver
  const resizeObserver = new ResizeObserver(() => {
    if (fitAddon) {
      fitAddon.fit();
      if (ptyId) window.api.ptyResize(ptyId, xterm.cols, xterm.rows);
    }
  });
  resizeObserver.observe(el);

  // Guardar en el Map
  const termInfo = { xterm, fitAddon, resizeObserver, ptyId, el, name: `Terminal ${localId}` };
  state.terminals.set(localId, termInfo);

  // Activar esta terminal
  activateTerminalInstance(localId);
  renderTerminalTabs();

  return localId;
}

/**
 * Activa una instancia de terminal específica, ocultando las demás.
 */
function activateTerminalInstance(localId) {
  state.activeTerminalId = localId;
  for (const [id, info] of state.terminals) {
    info.el.classList.toggle('active', id === localId);
  }
  const active = state.terminals.get(localId);
  if (active) {
    if (active.fitAddon) setTimeout(() => active.fitAddon.fit(), 50);
    active.xterm.focus();
  }
  renderTerminalTabs();
}

/**
 * Cierra una instancia de terminal: mata el pty, destruye xterm,
 * desconecta el ResizeObserver, y limpia el DOM.
 */
function closeTerminalInstance(localId) {
  const info = state.terminals.get(localId);
  if (!info) return;

  // Kill pty
  if (info.ptyId) window.api.ptyKill(info.ptyId);

  // Cleanup
  info.resizeObserver.disconnect();
  info.xterm.dispose();
  info.el.remove();
  state.terminals.delete(localId);

  // Si era la activa, activar otra o cerrar el tab
  if (state.activeTerminalId === localId) {
    const remaining = [...state.terminals.keys()];
    if (remaining.length > 0) {
      activateTerminalInstance(remaining[remaining.length - 1]);
    } else {
      state.activeTerminalId = null;
      closeTab('__terminal__');
    }
  }
  renderTerminalTabs();
}

/**
 * Renderiza la barra de tabs interna de las terminales.
 */
function renderTerminalTabs() {
  const container = document.getElementById('terminal-tabs');
  if (!container) return;

  container.innerHTML = '';
  for (const [id, info] of state.terminals) {
    const tab = document.createElement('button');
    tab.className = `terminal-tab${id === state.activeTerminalId ? ' active' : ''}`;
    tab.innerHTML = `<span>${info.name}</span><span class="terminal-tab-close" data-id="${id}">×</span>`;
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.terminal-tab-close')) return;
      activateTerminalInstance(id);
    });
    container.appendChild(tab);
  }

  // Close button handlers
  container.querySelectorAll('.terminal-tab-close').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTerminalInstance(parseInt(btn.dataset.id, 10));
    });
  });
}

/**
 * Inicializa el sistema de multi-terminal: registra los IPC listeners
 * globales para pty:data y pty:exit, y el botón "+" para crear terminales.
 */
async function initTerminal() {
  // ── IPC listeners globales (routean por ptyId) ──
  window.api.onPtyData((ptyId, data) => {
    for (const info of state.terminals.values()) {
      if (info.ptyId === ptyId) {
        info.xterm.write(data);
        scheduleGitBranchRefresh();
        break;
      }
    }
  });

  window.api.onPtyExit((ptyId, code) => {
    for (const [id, info] of state.terminals) {
      if (info.ptyId === ptyId) {
        info.xterm.writeln(`\r\n\x1b[33mProcess exited with code ${code}\x1b[0m`);
        info.ptyId = null; // Marcar como sin pty
        break;
      }
    }
  });

  // ── Botón "+" para crear nueva terminal ──
  document.getElementById('terminal-add-btn')?.addEventListener('click', () => {
    createTerminalInstance();
  });
}

// ┌──────────────────────────────────────────────────┐
// │  CARPETAS RECIENTES                               │
// │  Guarda las últimas 5 carpetas abiertas en        │
// │  localStorage para mostrarlas en la welcome        │
// │  screen al iniciar la app.                        │
// └──────────────────────────────────────────────────┘

const RECENT_FOLDERS_KEY = 'mojavecode:recentFolders';
const MAX_RECENT_FOLDERS = 5;

/**
 * Guardar una carpeta en la lista de recientes.
 * La mueve al tope si ya existía, y recorta a MAX_RECENT_FOLDERS.
 */
function saveRecentFolder(folderPath) {
  let recent = getRecentFolders();
  // Si ya existe, sacarla para ponerla al tope
  recent = recent.filter((p) => p !== folderPath);
  recent.unshift(folderPath);
  // Recortar a las últimas 5
  if (recent.length > MAX_RECENT_FOLDERS) recent.length = MAX_RECENT_FOLDERS;
  localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(recent));
}

function getRecentFolders() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_FOLDERS_KEY)) || [];
  } catch {
    return [];
  }
}

/**
 * Renderizar la lista de carpetas recientes en la welcome screen.
 * Cada item es clickeable y abre la carpeta directamente.
 */
function renderRecentFolders() {
  const container = document.getElementById('welcome-recent');
  if (!container) return;
  const recent = getRecentFolders();

  if (!recent.length) {
    container.innerHTML = '';
    return;
  }

  let html = '<div class="recent-title">Recent</div><div class="recent-list">';
  for (const folderPath of recent) {
    const name = folderPath.split(/[/\\]/).pop();
    // Ruta padre para mostrar contexto (ej: ~/projects)
    const parent = folderPath.substring(0, folderPath.lastIndexOf('/'));
    const shortParent = parent.replace(/^\/Users\/[^/]+/, '~');
    html += `<div class="recent-item" data-path="${escapeAttr(folderPath)}" title="${escapeAttr(folderPath)}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <div class="recent-item-text">
        <span class="recent-item-name">${escapeHtml(name)}</span>
        <span class="recent-item-path">${escapeHtml(shortParent)}</span>
      </div>
    </div>`;
  }
  html += '</div>';
  container.innerHTML = html;

  // Click en una carpeta reciente → abrirla
  container.querySelectorAll('.recent-item').forEach((item) => {
    item.addEventListener('click', () => {
      const path = item.dataset.path;
      loadFileTree(path);
    });
  });
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

  // Guardar en recientes (últimas 5 carpetas) en localStorage
  // y notificar al main process para que actualice el menú nativo.
  saveRecentFolder(folderPath);
  window.api.notifyRecentFolder(folderPath);

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
      _lastKnownBranch = result.output;
    }
  });

  // Iniciar LSPs para esta carpeta (PHP + TS/JS)
  if (typeof startLsp === 'function') {
    startLsp(folderPath);
  }
  if (typeof startTsLsp === 'function') {
    startTsLsp(folderPath);
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

      item.addEventListener('click', async () => {
        const chevron = item.querySelector('.tree-chevron');
        const isExpanded = chevron.textContent === '▾';
        if (!isExpanded) {
          // Lazy load: cargar hijos al expandir
          const childContainer = document.createElement('div');
          childContainer.className = 'tree-children';
          item.after(childContainer);
          await renderTreeLevel(entry.path, childContainer, depth + 1);
          chevron.textContent = '▾';
        } else {
          // Colapsar: remover hijos
          const next = item.nextElementSibling;
          if (next?.classList.contains('tree-children')) next.remove();
          chevron.textContent = '▸';
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
// │  CONTEXT MENU DEL FILE TREE                      │
// │  Click derecho sobre archivos/carpetas para:     │
// │  copiar ruta, copiar, pegar, eliminar.           │
// │                                                  │
// │  El menú es un <div> posicionado con position:   │
// │  fixed que aparece en las coordenadas del click. │
// │  Se oculta al hacer click en cualquier otro lado.│
// └──────────────────────────────────────────────────┘

// Estado del portapapeles interno del file tree.
// Cuando el usuario hace "Copy" guardamos la ruta acá,
// y al hacer "Paste" la usamos como origen de la copia.
const treeContextState = { copiedPath: null, copiedIsDir: false };

function initTreeContextMenu() {
  const menu = document.getElementById('tree-context-menu');
  const fileTree = document.getElementById('file-tree');

  // Cerrar el menú al hacer click en cualquier parte
  document.addEventListener('click', () => {
    menu.style.display = 'none';
  });

  // Abrir menú contextual al hacer click derecho sobre un item del árbol
  fileTree.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.tree-item');
    if (!item) return;
    e.preventDefault();

    const targetPath = item.dataset.path;
    menu.dataset.targetPath = targetPath;

    // "Paste" solo está habilitado si hay algo copiado
    const pasteItem = menu.querySelector('[data-action="paste-file"]');
    pasteItem.classList.toggle('context-menu-disabled', !treeContextState.copiedPath);

    // Posicionar el menú donde hizo click el usuario
    menu.style.display = 'block';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    // Si el menú se sale de la pantalla, reposicionar
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  // Manejar las acciones del menú
  menu.addEventListener('click', async (e) => {
    const action = e.target.closest('.context-menu-item')?.dataset.action;
    if (!action) return;
    const targetPath = menu.dataset.targetPath;
    menu.style.display = 'none';

    // ── Copy Path: copiar la ruta absoluta al clipboard del SO ──
    if (action === 'copy-path') {
      navigator.clipboard.writeText(targetPath);
    }

    // ── Copy: guardar la ruta en el portapapeles interno ──
    if (action === 'copy-file') {
      treeContextState.copiedPath = targetPath;
      const stat = await window.api.stat(targetPath);
      treeContextState.copiedIsDir = stat?.isDirectory || false;
    }

    // ── Paste: copiar el archivo/carpeta al directorio seleccionado ──
    if (action === 'paste-file') {
      if (!treeContextState.copiedPath) return;
      const srcPath = treeContextState.copiedPath;
      const srcName = srcPath.split(/[/\\]/).pop();

      // Si el destino es un archivo, pegar en su carpeta padre
      const stat = await window.api.stat(targetPath);
      const destDir = stat?.isDirectory ? targetPath : targetPath.substring(0, targetPath.lastIndexOf('/'));
      let destPath = `${destDir}/${srcName}`;

      // Si ya existe un archivo con ese nombre, agregar " - Copy"
      const destStat = await window.api.stat(destPath);
      if (destStat) {
        const ext = srcName.includes('.') ? '.' + srcName.split('.').pop() : '';
        const base = ext ? srcName.slice(0, -ext.length) : srcName;
        destPath = `${destDir}/${base} - Copy${ext}`;
      }

      const result = await window.api.copyFile(srcPath, destPath);
      if (result.error) {
        alert(`Error copying: ${result.error}`);
      } else {
        refreshTreeParent(destDir);
      }
    }

    // ── Delete: eliminar con confirmación ──
    if (action === 'delete-file') {
      const name = targetPath.split(/[/\\]/).pop();
      if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

      // Si el archivo está abierto en una pestaña, cerrarla primero
      const openTab = state.openTabs.find((t) => t.path === targetPath);
      if (openTab) closeTab(targetPath);

      const result = await window.api.deleteFile(targetPath);
      if (result.error) {
        alert(`Error deleting: ${result.error}`);
      } else {
        const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
        refreshTreeParent(parentDir);
      }
    }
  });
}

/**
 * Refrescar una carpeta en el file tree después de copiar/eliminar.
 *
 * Busca la carpeta padre en el árbol y simula un colapso + expansión
 * para que se vuelvan a cargar los hijos desde disco (lazy load).
 * Si no la encuentra (ej: la raíz), recarga todo el árbol.
 */
function refreshTreeParent(dirPath) {
  const items = document.querySelectorAll('.tree-item');
  for (const item of items) {
    if (item.dataset.path === dirPath) {
      const chevron = item.querySelector('.tree-chevron');
      if (chevron && chevron.textContent === '▾') {
        item.click();   // colapsar
        setTimeout(() => item.click(), 50); // re-expandir
      }
      return;
    }
  }
  // Fallback: recargar todo el árbol si no encontramos la carpeta
  if (state.currentFolder) loadFileTree(state.currentFolder);
}

// ┌──────────────────────────────────────────────────┐
// │  3b. REVEAL FILE IN TREE                         │
// │  Expande las carpetas ancestro de un archivo y   │
// │  hace scroll hasta él en el sidebar, similar al  │
// │  "Reveal in Side Bar" de VS Code.                │
// │                                                  │
// │  Se ejecuta automáticamente al activar un tab    │
// │  (abrir archivo nuevo o cambiar de pestaña).     │
// │                                                  │
// │  DESAFÍO TÉCNICO:                                │
// │  El file tree usa lazy loading — las carpetas    │
// │  cargan sus hijos desde disco recién al          │
// │  expandirse. Entonces para revelar un archivo    │
// │  en una carpeta profunda, necesitamos expandir   │
// │  nivel por nivel, esperando a que cada readDir   │
// │  termine y sus items aparezcan en el DOM antes   │
// │  de continuar al siguiente nivel.                │
// └──────────────────────────────────────────────────┘

/**
 * Revelar un archivo en el file tree.
 *
 * Ejemplo: para revelar /proyecto/app/Models/User.php necesita:
 * 1. Verificar que "app" esté expandido (si no, click → esperar)
 * 2. Verificar que "Models" esté expandido (si no, click → esperar)
 * 3. Encontrar "User.php" en el DOM y hacer scroll
 */
async function revealFileInTree(filePath) {
  if (!state.currentFolder || !filePath) return;
  if (!filePath.startsWith(state.currentFolder)) return;

  // Caso rápido: si el item ya está renderizado en el DOM,
  // solo necesitamos hacer scroll (la carpeta ya estaba expandida)
  const existing = document.querySelector(`.tree-item[data-path="${CSS.escape(filePath)}"]`);
  if (existing) {
    existing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }

  // Descomponer la ruta relativa en segmentos de carpeta.
  // Ej: "app/Models/User.php" → ["app", "Models"] (sin el archivo)
  const relative = filePath.slice(state.currentFolder.length + 1);
  const parts = relative.split('/');
  parts.pop();

  // Expandir cada carpeta ancestro de arriba hacia abajo
  let currentPath = state.currentFolder;

  for (const part of parts) {
    currentPath += '/' + part;
    const dirItem = document.querySelector(`.tree-item[data-path="${CSS.escape(currentPath)}"]`);

    // Si no encontramos el tree-item de esta carpeta, significa que
    // un nivel anterior no se expandió correctamente — no podemos continuar
    if (!dirItem) break;

    const chevron = dirItem.querySelector('.tree-chevron');
    if (chevron && chevron.textContent === '▸') {
      // Carpeta colapsada: click para expandir (dispara el lazy load)
      dirItem.click();
      // Esperar a que renderTreeLevel termine y los hijos aparezcan en el DOM
      await waitForTreeChildren(dirItem);
    }
  }

  // Después de expandir todo el path, el archivo debería existir en el DOM
  const fileItem = document.querySelector(`.tree-item[data-path="${CSS.escape(filePath)}"]`);
  if (fileItem) {
    fileItem.classList.add('active');
    fileItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

/**
 * Esperar a que un directorio del tree cargue sus hijos en el DOM.
 *
 * Cuando se hace click en una carpeta colapsada, renderTreeLevel()
 * crea un div.tree-children y lo inserta justo después del .tree-item
 * de la carpeta. Usamos un MutationObserver para detectar cuándo
 * aparece ese div y resolver la promesa.
 *
 * Incluye un timeout de 2s como safety net por si readDir falla
 * silenciosamente o la carpeta está vacía y no se crea el container.
 */
function waitForTreeChildren(dirItem) {
  return new Promise((resolve) => {
    // Si ya tiene hijos (estaba expandido), resolver de inmediato
    const next = dirItem.nextElementSibling;
    if (next && next.classList.contains('tree-children')) {
      resolve();
      return;
    }

    const observer = new MutationObserver(() => {
      const sibling = dirItem.nextElementSibling;
      if (sibling && sibling.classList.contains('tree-children')) {
        observer.disconnect();
        resolve();
      }
    });

    observer.observe(dirItem.parentElement, { childList: true });

    // Safety net: no quedarnos bloqueados si la carpeta está vacía
    // o hay un error de lectura
    setTimeout(() => { observer.disconnect(); resolve(); }, 2000);
  });
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

  // ── .env → abrir como panel visual en vez de Monaco ────────
  const baseName = (fileName || filePath.split(/[/\\]/).pop());
  if (/^\.env(\.\w+)?$/.test(baseName)) {
    openEnvViewer(filePath, baseName);
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

  // Empezar a observar el archivo para detectar cambios externos
  window.api.watchAdd(filePath);

  // Notificar a los LSPs según el tipo de archivo
  if (typeof lspTrackModel === 'function') {
    lspTrackModel(model, language);
  }
  if (typeof tsLspTrackModel === 'function') {
    tsLspTrackModel(model);
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

// Registry de tabs especiales: mapea path (o prefijo) a su container y config.
// Para agregar un nuevo tab especial, solo hay que agregar una entrada acá.
const specialTabs = [
  { match: '__terminal__',        container: 'terminal-container',       display: 'flex', label: 'Terminal',  onActivate: () => { if (state.activeTerminalId) activateTerminalInstance(state.activeTerminalId); } },
  { match: '__git-graph__',       container: 'git-graph-container',      display: 'block', label: 'Git Graph' },
  { match: '__diff__',            container: 'diff-container',           display: 'flex',  label: 'Diff',      prefix: true, onActivate: (tab) => { if (tab.diffEditor) { setTimeout(() => tab.diffEditor.layout(), 50); } else { closeTab(tab.path); } } },
  { match: '__conflict__',        container: 'diff-container',           display: 'flex',  label: 'Conflict',  prefix: true, onActivate: (tab) => { if (tab.conflictEditors) { setTimeout(() => tab.conflictEditors.forEach((e) => e.layout()), 50); } else { closeTab(tab.path); } } },
  { match: '__errorlog__',        container: 'errorlog-container',       display: 'flex',  label: 'Error Log' },
  { match: '__command-output__',  container: 'command-output-container', display: 'block', label: 'Output' },
  { match: '__db-viewer__',       container: 'db-viewer-container',      display: 'flex',  label: 'Database' },
  { match: '__route-list__',      container: 'route-list-container',     display: 'flex',  label: 'Routes' },
  { match: '__log:',             container: 'log-viewer-container',     display: 'flex',  label: 'Log', prefix: true },
  { match: '__claude-detail__',  container: 'claude-detail-container',  display: 'flex',  label: 'Claude',  prefix: true },
  { match: '__history-detail__', container: 'history-detail-container', display: 'flex',  label: 'Prompt',  prefix: true },
  { match: '__env-viewer__',    container: 'env-viewer-container',     display: 'flex',  label: '.env',    prefix: true },
];

function activateTab(tab) {
  state.activeTab = tab;
  document.getElementById('welcome').style.display = 'none';

  // Buscar si es un tab especial
  const special = specialTabs.find((s) =>
    s.prefix ? tab.path.startsWith(s.match) : tab.path === s.match
  );

  // Ocultar todos los containers, mostrar solo el que corresponde
  const activeContainer = special ? special.container : 'editor-container';
  document.getElementById('editor-container').style.display = 'none';
  for (const s of specialTabs) {
    document.getElementById(s.container).style.display = 'none';
  }
  document.getElementById(activeContainer).style.display = special ? special.display : 'block';

  if (special) {
    document.getElementById('status-language').textContent = special.label;
    clearBlame();
    if (special.onActivate) special.onActivate(tab);
  } else {
    // Tab de archivo normal → Monaco editor
    state.editor.setModel(tab.model);
    document.getElementById('status-language').textContent =
      getLanguageDisplayName(tab.language);
    state.editor.focus();
    clearBlame();
    renderBreakpointDecorations();
    // Aplicar highlights de modelos/métodos si es PHP
    if (tab.language === 'php') setTimeout(highlightModelCalls, 50);
  }

  // Highlight en file tree y revelar ubicación
  document.querySelectorAll('.tree-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === tab.path);
  });
  if (!tab.path.startsWith('__')) {
    revealFileInTree(tab.path);
  }

  renderTabs();
  updateBreadcrumb();
  updateOutline();
}

/**
 * Actualizar la barra de breadcrumb con la ruta del archivo activo.
 *
 * Muestra la ruta relativa al proyecto (sin el prefijo de currentFolder)
 * dividida en segmentos separados por "/". El último segmento (nombre
 * del archivo) se resalta en color primario y bold via CSS.
 *
 * Se oculta en tabs especiales (terminal, db, git graph, etc.)
 * porque no tienen una ruta de archivo real.
 */
function updateBreadcrumb() {
  const bar = document.getElementById('breadcrumb-bar');
  const tab = state.activeTab;

  // Ocultar si no hay tab activo o es un tab especial (__terminal__, etc.)
  if (!tab || !tab.path || tab.path.startsWith('__')) {
    bar.style.display = 'none';
    return;
  }

  // Quitar el prefijo de la carpeta del proyecto para mostrar ruta relativa
  let displayPath = tab.path;
  if (state.currentFolder && displayPath.startsWith(state.currentFolder)) {
    displayPath = displayPath.slice(state.currentFolder.length + 1);
  }

  // Armar los segmentos: app / Http / Controllers / UserController.php
  const parts = displayPath.split('/');
  bar.style.display = 'flex';
  bar.innerHTML = parts.map((p, i) =>
    `${i > 0 ? '<span class="breadcrumb-sep">/</span>' : ''}<span class="breadcrumb-part">${escapeHtml(p)}</span>`
  ).join('');
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

  // Matar todos los procesos pty si el usuario cierra el tab de terminal
  if (tab.path === '__terminal__') {
    for (const [id, info] of state.terminals) {
      if (info.ptyId) window.api.ptyKill(info.ptyId);
      info.resizeObserver.disconnect();
      info.xterm.dispose();
      info.el.remove();
    }
    state.terminals.clear();
    state.activeTerminalId = null;
  }

  // Limpiar diff editor si aplica (dispose editor ANTES que los models)
  if (tab.diffEditor) {
    try { tab.diffEditor.dispose(); } catch { /* already disposed */ }
    if (tab.diffModels) {
      tab.diffModels.forEach((m) => { try { m.dispose(); } catch { /* ok */ } });
    }
    document.getElementById('diff-container').innerHTML = '';
  }

  // Notificar al LSP y destruir model (solo para tabs de archivo, no especiales).
  // IMPORTANTE: no destruir el model si el mismo archivo está abierto en el
  // pane derecho — ambos panes comparten el mismo TextModel y al dispose()
  // lo eliminaría de los dos editores simultáneamente.
  const isSpecialTab = tab.path.startsWith('__');
  const isAlsoInRightPane = state.openTabsRight.some((t) => t.path === tab.path);
  if (!isSpecialTab && tab.model && !isAlsoInRightPane) {
    if (typeof lspUntrackModel === 'function') lspUntrackModel(tab.model);
    if (typeof tsLspUntrackModel === 'function') tsLspUntrackModel(tab.model);
    try { tab.model.dispose(); } catch { /* ya dispuesto */ }
    tab.model = null;
    window.api.watchRemove(tab.path);
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
      // Ocultar todos los containers especiales para que no quede
      // ninguno visible debajo del welcome screen
      for (const s of specialTabs) {
        document.getElementById(s.container).style.display = 'none';
      }
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

  // Matar todos los ptys si hay terminales abiertas
  if (state.openTabs.some((t) => t.path === '__terminal__')) {
    for (const info of state.terminals.values()) {
      if (info.ptyId) window.api.ptyKill(info.ptyId);
      info.resizeObserver.disconnect();
      info.xterm.dispose();
      info.el.remove();
    }
    state.terminals.clear();
    state.activeTerminalId = null;
  }

  // Disponer todos los models y diff editors (proteger contra doble dispose)
  for (const tab of state.openTabs) {
    if (tab.diffEditor) {
      if (tab.diffModels) tab.diffModels.forEach((m) => { try { m.dispose(); } catch {} });
      try { tab.diffEditor.dispose(); } catch {}
    }
    if (tab.model && !tab.path.startsWith('__')) {
      if (typeof lspUntrackModel === 'function') lspUntrackModel(tab.model);
      if (typeof tsLspUntrackModel === 'function') tsLspUntrackModel(tab.model);
      try { tab.model.dispose(); } catch {}
      tab.model = null;
    }
  }

  state.openTabs = [];
  state.activeTab = null;

  // Destruir todos los watchers de archivos de una vez
  window.api.watchClear();

  document.getElementById('diff-container').innerHTML = '';
  document.getElementById('git-graph-container').innerHTML = '';
  document.getElementById('welcome').style.display = 'flex';
  document.getElementById('editor-container').style.display = 'none';
  document.getElementById('terminal-container').style.display = 'none';
  document.getElementById('git-graph-container').style.display = 'none';
  document.getElementById('diff-container').style.display = 'none';

  // Limpiar pane derecho si el split estaba activo
  if (state.split) {
    state.openTabsRight = [];
    state.activeTabRight = null;
    state.activePaneRight = false;
    if (state.editorRight) state.editorRight.setModel(null);
    document.getElementById('editor-container-right').style.display = 'none';
    document.getElementById('welcome-right').style.display = 'flex';
    document.getElementById('breadcrumb-bar-right').style.display = 'none';
    renderTabsRight();
  }

  renderTabs();
  updateBreadcrumb();
  updateOutline();
}

/**
 * Resetea todas las terminales con un nuevo cwd (al cambiar de proyecto).
 * Mata todos los ptys y respawnea con el nuevo directorio.
 */
async function resetTerminal(cwd) {
  for (const [id, info] of state.terminals) {
    info.xterm.clear();
    if (info.ptyId) {
      await window.api.ptyKill(info.ptyId);
    }
    const result = await window.api.ptySpawn(cwd);
    info.ptyId = result.id || null;
    if (result.error) {
      info.xterm.writeln(`\x1b[31mTerminal error: ${result.error}\x1b[0m`);
    }
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
          const t = state.openTabs.find(t => t.path === el.dataset.tabPath);
          if (t) activateTab(t);
        }
      });
      bar.appendChild(el);
    }

    // Guardar referencia al path para click y drag
    el.dataset.tabPath = tab.path;
    el.draggable = true;

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

/**
 * Drag & Drop para reordenar pestañas.
 *
 * Funciona con el HTML5 Drag and Drop API nativo del browser.
 * Cada .tab tiene draggable=true (seteado en renderTabs).
 *
 * CÓMO FUNCIONA:
 * ─────────────────
 * 1. dragstart  → guarda el path del tab arrastrado, lo marca semi-transparente
 * 2. dragover   → calcula si el mouse está en la mitad izquierda o derecha
 *                 del tab destino, y muestra un indicador (línea accent)
 *                 en ese lado para indicar dónde se insertará
 * 3. drop       → reordena el array state.openTabs y re-renderiza
 * 4. dragend    → limpia las clases CSS de feedback visual
 *
 * Se usa event delegation en el #tab-bar en vez de listeners
 * individuales para no tener que reconectar al re-renderizar.
 */
(function initTabDragAndDrop() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;

  let draggedPath = null;

  const overlay   = document.getElementById('split-drop-overlay');
  const paneRight = document.getElementById('pane-right');

  // ── Inicio del drag: marcar el tab como "en vuelo" ──
  // Si el split está activo, mostramos el overlay sobre el pane derecho
  // para que capture los eventos de drag que Monaco absorbería.
  bar.addEventListener('dragstart', (e) => {
    const tabEl = e.target.closest('.tab');
    if (!tabEl) return;
    draggedPath = tabEl.dataset.tabPath;
    tabEl.classList.add('tab-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(tabEl, tabEl.offsetWidth / 2, tabEl.offsetHeight / 2);
    if (state.split) overlay.style.display = 'block';
  });

  // ── Mientras se arrastra sobre otros tabs ──
  // Determina la posición de inserción dividiendo el tab destino
  // en dos mitades: izquierda (insertar antes) y derecha (insertar después).
  bar.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const targetEl = e.target.closest('.tab');
    if (!targetEl || targetEl.dataset.tabPath === draggedPath) return;

    const rect = targetEl.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;

    // Limpiar indicadores previos antes de mostrar el nuevo
    bar.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('tab-drop-before', 'tab-drop-after');
    });

    if (e.clientX < midX) {
      targetEl.classList.add('tab-drop-before');
    } else {
      targetEl.classList.add('tab-drop-after');
    }
  });

  bar.addEventListener('dragleave', (e) => {
    const tabEl = e.target.closest('.tab');
    if (tabEl) tabEl.classList.remove('tab-drop-before', 'tab-drop-after');
  });

  // ── Drop: aplicar el reorden al array de tabs ──
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    bar.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('tab-drop-before', 'tab-drop-after', 'tab-dragging');
    });

    const targetEl = e.target.closest('.tab');
    if (!targetEl || !draggedPath || targetEl.dataset.tabPath === draggedPath) return;

    const fromIdx = state.openTabs.findIndex(t => t.path === draggedPath);
    const toIdx = state.openTabs.findIndex(t => t.path === targetEl.dataset.tabPath);
    if (fromIdx === -1 || toIdx === -1) return;

    // Calcular el índice final de inserción.
    // Si el mouse está en la mitad izquierda → insertar en toIdx (antes),
    // si está en la derecha → insertar en toIdx + 1 (después).
    // Compensar si el origen estaba antes del destino (el splice desplaza).
    const rect = targetEl.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    let insertIdx = e.clientX < midX ? toIdx : toIdx + 1;
    if (fromIdx < insertIdx) insertIdx--;

    const [moved] = state.openTabs.splice(fromIdx, 1);
    state.openTabs.splice(insertIdx, 0, moved);
    renderTabs();
  });

  // ── Cleanup: siempre limpiar las clases de feedback ──
  bar.addEventListener('dragend', () => {
    draggedPath = null;
    overlay.style.display = 'none';
    paneRight.classList.remove('split-drop-target');
    bar.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('tab-dragging', 'tab-drop-before', 'tab-drop-after');
    });
  });

  // ── Drop zone del pane derecho ─────────────────────────────────
  // El overlay intercepta los eventos que Monaco absorbería.
  // draggedPath es accesible directamente desde este mismo closure.
  overlay.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    paneRight.classList.add('split-drop-target');
  });

  overlay.addEventListener('dragleave', () => {
    paneRight.classList.remove('split-drop-target');
  });

  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    overlay.style.display = 'none';
    paneRight.classList.remove('split-drop-target');
    if (!draggedPath || draggedPath.startsWith('__')) return;
    const tab = state.openTabs.find((t) => t.path === draggedPath);
    if (tab) openFileInRightPane(tab.path, tab.name);
  });
})();

// ┌──────────────────────────────────────────────────┐
// │  SPLIT EDITOR                                    │
// │  Dos paneles de código independientes, cada uno  │
// │  con su propio Monaco, tab bar y lista de tabs.  │
// │  Toggle con Cmd+\ o el botón en el tab bar.      │
// └──────────────────────────────────────────────────┘

/**
 * Crea el Monaco editor del pane derecho la primera vez que se habilita
 * el split. Las llamadas siguientes retornan de inmediato (lazy init).
 *
 * El editor derecho comparte la misma configuración visual que el izquierdo
 * (tema, fuente, tamaño) y escucha eventos para actualizar el status bar
 * y marcar tabs como modificados.
 */
function ensureRightEditor() {
  if (state.editorRight) return;

  state.editorRight = monaco.editor.create(
    document.getElementById('editor-container-right'),
    {
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: state.zoom.fontSize,
      lineHeight: 22,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      'semanticHighlighting.enabled': true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true },
      padding: { top: 8 },
      automaticLayout: true,
      tabSize: 2,
      wordWrap: 'off',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
    }
  );

  // Foco en el editor derecho → marcar pane derecho como activo
  state.editorRight.onDidFocusEditorWidget(() => {
    state.activePaneRight = true;
  });

  // Posición del cursor → status bar (solo si el pane derecho tiene el foco)
  state.editorRight.onDidChangeCursorPosition((e) => {
    if (state.activePaneRight) {
      document.getElementById('status-cursor').textContent =
        `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
    }
  });

  // Cambios en contenido → marcar tab derecho como modificado + auto-save
  state.editorRight.onDidChangeModelContent(() => {
    if (state.activeTabRight && !state.activeTabRight.modified) {
      state.activeTabRight.modified = true;
      renderTabsRight();
    }
    if (state.autoSave && state.activeTabRight?.model) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = setTimeout(() => saveCurrentFile(), 1000);
    }
  });

  // Cmd+S en el editor derecho → guardar archivo del pane derecho
  state.editorRight.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
    () => saveCurrentFile()
  );

  // Cmd+W en el editor derecho → cerrar tab activo del pane derecho
  state.editorRight.addCommand(
    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW,
    () => { if (state.activeTabRight) closeTabRight(state.activeTabRight.path); }
  );
}

/**
 * Activa un tab en el pane derecho: carga el model en el editor derecho,
 * muestra el container, y actualiza el breadcrumb derecho.
 *
 * @param {object} tab - { path, name, model, modified }
 */
function activateTabRight(tab) {
  state.activeTabRight = tab;
  state.activePaneRight = true;

  document.getElementById('welcome-right').style.display = 'none';
  document.getElementById('editor-container-right').style.display = 'block';

  state.editorRight.setModel(tab.model);
  state.editorRight.focus();

  renderTabsRight();
  updateBreadcrumbRight();
}

/**
 * Renderiza los tabs en el tab bar del pane derecho (#tab-bar-right).
 * Mismo patrón que renderTabs() pero para la lista openTabsRight.
 */
function renderTabsRight() {
  const bar = document.getElementById('tab-bar-right');
  const existingEls = Array.from(bar.children);
  const tabCount = state.openTabsRight.length;

  while (existingEls.length > tabCount) {
    existingEls.pop().remove();
  }

  state.openTabsRight.forEach((tab, i) => {
    let el = existingEls[i];
    const isActive = state.activeTabRight === tab;
    const label = `${tab.modified ? '● ' : ''}${tab.name}`;

    if (!el) {
      el = document.createElement('div');
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          closeTabRight(e.target.dataset.path);
        } else {
          const t = state.openTabsRight.find((t) => t.path === el.dataset.tabPath);
          if (t) activateTabRight(t);
        }
      });
      bar.appendChild(el);
    }

    el.dataset.tabPath = tab.path;
    el.className = `tab ${isActive ? 'active' : ''}`;
    const nameSpan = el.querySelector('.tab-name');
    if (!nameSpan || nameSpan.textContent !== label || el.querySelector('.tab-close')?.dataset.path !== tab.path) {
      el.innerHTML = `
        <span class="tab-name">${label}</span>
        <span class="tab-close" data-path="${tab.path}">✕</span>`;
    }
  });
}

/**
 * Cierra un tab del pane derecho.
 *
 * IMPORTANTE: No destruye el Monaco TextModel — el mismo model puede
 * estar abierto simultáneamente en el pane izquierdo. Solo remueve
 * la referencia de openTabsRight.
 *
 * @param {string} tabPath - Path del tab a cerrar
 */
function closeTabRight(tabPath) {
  const idx = state.openTabsRight.findIndex((t) => t.path === tabPath);
  if (idx === -1) return;

  const tab = state.openTabsRight[idx];
  if (tab.modified && tab.model) {
    const save = confirm(`"${tab.name}" has unsaved changes. Close without saving?`);
    if (!save) return;
  }

  state.openTabsRight.splice(idx, 1);

  if (state.activeTabRight?.path === tabPath) {
    const next = state.openTabsRight[idx < state.openTabsRight.length ? idx : idx - 1];
    if (next) {
      activateTabRight(next);
    } else {
      state.activeTabRight = null;
      if (state.editorRight) state.editorRight.setModel(null);
      document.getElementById('editor-container-right').style.display = 'none';
      document.getElementById('welcome-right').style.display = 'flex';
      document.getElementById('breadcrumb-bar-right').style.display = 'none';
    }
  }

  renderTabsRight();
}

/**
 * Abre un archivo en el pane derecho. Si ya está en openTabsRight lo reactiva.
 * Si el mismo archivo está abierto en el pane izquierdo, reutiliza su model
 * para evitar leer el archivo dos veces y mantener el estado de undo/redo sincronizado.
 *
 * @param {string} filePath
 * @param {string} [fileName]
 */
async function openFileInRightPane(filePath, fileName) {
  const existing = state.openTabsRight.find((t) => t.path === filePath);
  if (existing) { activateTabRight(existing); return; }

  // Reusar model del pane izquierdo si el archivo ya está abierto allá
  const leftTab = state.openTabs.find((t) => t.path === filePath);
  let model, language;

  if (leftTab) {
    model    = leftTab.model;
    language = leftTab.language;
  } else {
    const result = await window.api.readFile(filePath);
    if (result.error) { console.error('Error reading file:', result.error); return; }
    const ext = filePath.split('.').pop();
    language  = getMonacoLanguage(ext);
    const uri = monaco.Uri.file(filePath);
    model     = monaco.editor.getModel(uri) || monaco.editor.createModel(result.content, language, uri);
  }

  const tab = {
    path: filePath,
    name: fileName || filePath.split(/[/\\]/).pop(),
    model,
    language,
    modified: false,
  };

  state.openTabsRight.push(tab);
  activateTabRight(tab);
}

/**
 * Actualiza el breadcrumb del pane derecho con la ruta relativa del tab activo.
 */
function updateBreadcrumbRight() {
  const bar = document.getElementById('breadcrumb-bar-right');
  const tab = state.activeTabRight;
  if (!tab || !tab.path || tab.path.startsWith('__')) {
    bar.style.display = 'none';
    return;
  }
  let displayPath = tab.path;
  if (state.currentFolder && displayPath.startsWith(state.currentFolder)) {
    displayPath = displayPath.slice(state.currentFolder.length + 1);
  }
  const parts = displayPath.split('/');
  bar.style.display = 'flex';
  bar.innerHTML = parts.map((p, i) =>
    `${i > 0 ? '<span class="breadcrumb-sep">/</span>' : ''}<span class="breadcrumb-part">${escapeHtml(p)}</span>`
  ).join('');
}

/**
 * Habilita el split: muestra el pane derecho, crea el editor derecho (lazy),
 * inicializa el resizer, y abre en el pane derecho el archivo activo del izquierdo
 * como punto de partida natural.
 */
function enableSplit() {
  state.split = true;
  ensureRightEditor();

  document.getElementById('pane-right').style.display = 'flex';
  document.getElementById('split-resizer').style.display = 'block';

  // Abrir el archivo activo del pane izquierdo en el pane derecho
  if (state.activeTab && !state.activeTab.path.startsWith('__')) {
    openFileInRightPane(state.activeTab.path, state.activeTab.name);
  }

  // Sincronizar zoom con el editor izquierdo
  if (state.editorRight) {
    state.editorRight.updateOptions({ fontSize: state.zoom.fontSize });
  }
}

/**
 * Deshabilita el split: cierra los tabs del pane derecho, oculta el pane
 * y el resizer, y devuelve el foco al editor izquierdo.
 */
function disableSplit() {
  state.split = false;
  state.activePaneRight = false;
  state.openTabsRight = [];
  state.activeTabRight = null;

  if (state.editorRight) state.editorRight.setModel(null);
  document.getElementById('pane-right').style.display = 'none';
  document.getElementById('split-resizer').style.display = 'none';
  document.getElementById('editor-container-right').style.display = 'none';
  document.getElementById('welcome-right').style.display = 'flex';
  document.getElementById('breadcrumb-bar-right').style.display = 'none';
  renderTabsRight();

  // Restaurar ancho del pane izquierdo (limpia el flex-basis fijado por el resizer)
  const paneLeft = document.getElementById('pane-left');
  paneLeft.style.flex = '';
  paneLeft.style.width = '';

  if (state.editor && state.activeTab && !state.activeTab.path.startsWith('__')) {
    state.editor.focus();
  }
}

/**
 * Inicializa el resizer de split. El usuario puede arrastrar el div
 * #split-resizer para ajustar el ancho relativo de los dos panes.
 * El pane izquierdo recibe un ancho fijo en px y el derecho ocupa el resto.
 */
function initSplitResizer() {
  const resizer  = document.getElementById('split-resizer');
  const paneLeft = document.getElementById('pane-left');

  let isDragging = false;
  let startX     = 0;
  let startW     = 0;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX     = e.clientX;
    startW     = paneLeft.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const totalW   = resizer.parentElement.getBoundingClientRect().width - 4;
    const newW     = Math.max(200, Math.min(startW + (e.clientX - startX), totalW - 200));
    paneLeft.style.flex  = 'none';
    paneLeft.style.width = `${newW}px`;
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });
}

/**
 * Inicializa el sistema de split editor: botones, atajos de teclado y resizer.
 * Se llama una sola vez desde init().
 */
function initSplitEditor() {
  document.getElementById('btn-split-editor').addEventListener('click', () => {
    state.split ? disableSplit() : enableSplit();
  });

  document.getElementById('btn-close-split').addEventListener('click', () => disableSplit());

  // Cmd+\ → toggle split
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
      e.preventDefault();
      state.split ? disableSplit() : enableSplit();
    }
  });

  // Foco en el editor izquierdo → marcar pane izquierdo como activo
  state.editor.onDidFocusEditorWidget(() => {
    state.activePaneRight = false;
  });

  initSplitResizer();
}

// ┌──────────────────────────────────────────────────┐
// │  5. FILE SAVE                                    │
// │  Escribe el contenido del tab activo a disco     │
// │  via IPC, marca el tab como no-modificado, y     │
// │  notifica al LSP del guardado.                   │
// └──────────────────────────────────────────────────┘
async function saveCurrentFile() {
  // Guardar el archivo del pane que tiene el foco (izquierdo o derecho)
  const tab    = state.activePaneRight ? state.activeTabRight : state.activeTab;
  const editor = state.activePaneRight ? state.editorRight    : state.editor;
  if (!tab || !tab.model) return;

  const content = tab.model.getValue();
  const result  = await window.api.writeFile(tab.path, content);

  if (result.success) {
    tab.modified = false;
    state.activePaneRight ? renderTabsRight() : renderTabs();

    // Notificar a los LSPs del save
    if (typeof lspDidSave === 'function' && tab.model) {
      lspDidSave(tab.model.uri.toString(), content);
    }
    if (typeof tsLspDidSave === 'function' && tab.model) {
      tsLspDidSave(tab.model.uri.toString(), content);
    }

    // Format on save para archivos PHP
    if (state.formatOnSave && tab.language === 'php') {
      const formatResult = await window.api.phpFormat(tab.path);
      if (formatResult && !formatResult.error) {
        const updated = await window.api.readFile(tab.path);
        if (updated.content !== null && updated.content !== content) {
          const position = editor.getPosition();
          tab.model.setValue(updated.content);
          if (position) editor.setPosition(position);
          tab.modified = false;
          state.activePaneRight ? renderTabsRight() : renderTabs();
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
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
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

/**
 * Pull o Push desde los botones del status bar.
 *
 * Flujo:
 * 1. Agrega la clase "syncing" al botón → CSS le pone una animación
 *    de spin en el SVG y desactiva pointer-events para evitar doble click.
 * 2. Ejecuta git pull o git push via IPC (mismo handler que usa el git panel).
 * 3. Si hay error lo manda a console.error (aparece en el Error Log).
 * 4. Al terminar quita la animación y refresca:
 *    - El nombre de la rama en el status bar (por si pull cambió algo)
 *    - El panel de git si está abierto (staged/unstaged files)
 */
async function statusBarGitSync(action) {
  if (!state.currentFolder) return;
  const btn = document.getElementById(action === 'pull' ? 'status-pull' : 'status-push');
  btn.classList.add('syncing');

  try {
    const result = action === 'pull'
      ? await window.api.gitPull(state.currentFolder)
      : await window.api.gitPush(state.currentFolder);

    if (result.error) {
      console.error(`Git ${action} error:`, result.error);
    }
  } catch (err) {
    console.error(`Git ${action} failed:`, err);
  }

  btn.classList.remove('syncing');

  // Refrescar el nombre de la rama y el estado del panel de git
  window.api.gitBranch(state.currentFolder).then((r) => {
    if (!r.error) document.getElementById('status-branch').textContent = `⎇ ${r.output}`;
  });
  if (typeof refreshGitStatus === 'function') refreshGitStatus();
}

// ┌──────────────────────────────────────────────────┐
// │  7b. BRANCH PICKER (Git Checkout)                │
// │  Paleta de búsqueda estilo VS Code para cambiar  │
// │  de rama git sin tocar la terminal.              │
// │                                                  │
// │  Se abre desde:                                  │
// │  - Menú nativo Git > Switch Branch (Cmd+Shift+B) │
// │  - Click en el nombre de la rama en el status bar│
// │                                                  │
// │  Muestra ramas locales y remotas, con la rama    │
// │  actual y main/master siempre al tope. Las ramas │
// │  remotas que no existen localmente se marcan con  │
// │  tag "remote" — al seleccionarlas, git crea una  │
// │  copia local automáticamente (tracking branch).  │
// │                                                  │
// │  Navegación: ↑↓ para moverse, Enter para         │
// │  confirmar, Escape para cancelar, y búsqueda     │
// │  incremental mientras se escribe.                │
// └──────────────────────────────────────────────────┘
let _branchPickerData = { local: [], remoteOnly: [], current: '' };
let _branchPickerSelected = 0;

/**
 * Abrir el branch picker: consulta las ramas al main process
 * y muestra la paleta con el input enfocado.
 */
async function showBranchPicker() {
  if (!state.currentFolder) return;

  const overlay = document.getElementById('branch-picker-overlay');
  const input = document.getElementById('branch-picker-input');

  const result = await window.api.gitListBranches(state.currentFolder);
  if (!result || result.error) return;

  _branchPickerData = result;
  _branchPickerSelected = 0;

  overlay.style.display = 'flex';
  input.value = '';
  input.focus();
  renderBranchList('');
}

function closeBranchPicker() {
  document.getElementById('branch-picker-overlay').style.display = 'none';
}

/**
 * Renderizar la lista de ramas filtrada y ordenada.
 *
 * Orden de prioridad:
 * 1. Rama actual (marcada con ● y color teal)
 * 2. main / master (siempre visible para poder volver fácil)
 * 3. Resto de ramas locales, alfabéticamente
 * 4. Ramas remotas que no existen localmente (tag "remote")
 *
 * El texto de búsqueda se resalta con <mark> en cada nombre.
 */
function renderBranchList(filter) {
  const list = document.getElementById('branch-picker-list');
  const { local, remoteOnly, current } = _branchPickerData;
  const q = filter.toLowerCase().trim();

  // Construir la lista unificada de ramas
  let allBranches = [];

  for (const b of local) {
    allBranches.push({ name: b, remote: false, isCurrent: b === current });
  }
  for (const b of remoteOnly) {
    allBranches.push({ name: b, remote: true, isCurrent: false });
  }

  // Filtro de búsqueda
  if (q) {
    allBranches = allBranches.filter(b => b.name.toLowerCase().includes(q));
  }

  // Orden: current → main/master → alfabético
  allBranches.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const aMain = a.name === 'main' || a.name === 'master';
    const bMain = b.name === 'main' || b.name === 'master';
    if (aMain !== bMain) return aMain ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Clamp del índice seleccionado por si la lista se achicó tras filtrar
  _branchPickerSelected = Math.min(_branchPickerSelected, Math.max(0, allBranches.length - 1));

  // Generar HTML de cada item
  list.innerHTML = allBranches.map((b, i) => {
    const classes = ['branch-item'];
    if (b.isCurrent) classes.push('current');
    if (i === _branchPickerSelected) classes.push('selected');

    // Resaltar la coincidencia de búsqueda dentro del nombre
    let nameHtml = escBranchHtml(b.name);
    if (q) {
      const idx = b.name.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const before = escBranchHtml(b.name.slice(0, idx));
        const match = escBranchHtml(b.name.slice(idx, idx + q.length));
        const after = escBranchHtml(b.name.slice(idx + q.length));
        nameHtml = `${before}<mark>${match}</mark>${after}`;
      }
    }

    const icon = b.isCurrent ? '●' : '⎇';
    const tag = b.remote ? 'remote' : (b.isCurrent ? 'current' : '');

    return `<div class="${classes.join(' ')}" data-branch="${escBranchAttr(b.name)}">
      <span class="branch-icon">${icon}</span>
      <span class="branch-name">${nameHtml}</span>
      ${tag ? `<span class="branch-tag">${tag}</span>` : ''}
    </div>`;
  }).join('');

  if (allBranches.length === 0) {
    list.innerHTML = '<div style="padding:10px 14px;color:var(--text-muted);font-size:13px;">No branches found</div>';
  }
}

// Helpers de escape para prevenir XSS al inyectar nombres de rama en HTML
function escBranchHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escBranchAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Ejecutar el checkout de una rama.
 *
 * Después de cambiar de rama:
 * - Actualiza el nombre en el status bar
 * - Refresca el panel de git (staged/unstaged pueden cambiar)
 * - Recarga el file tree (archivos distintos según la rama)
 */
async function checkoutBranch(branchName) {
  if (!state.currentFolder || !branchName) return;
  closeBranchPicker();

  const result = await window.api.gitCheckout(state.currentFolder, branchName);
  if (result.error) {
    console.error('Git checkout error:', result.error);
    return;
  }

  _lastKnownBranch = branchName;
  document.getElementById('status-branch').textContent = `⎇ ${branchName}`;
  if (typeof refreshGitStatus === 'function') refreshGitStatus();
  if (state.currentFolder) loadFileTree(state.currentFolder);
}

/**
 * Inicializar event listeners del branch picker.
 *
 * Se ejecuta como IIFE al cargar el script. Usa event delegation
 * en el #branch-picker-list para los clicks en items.
 */
(function initBranchPicker() {
  const overlay = document.getElementById('branch-picker-overlay');
  const input = document.getElementById('branch-picker-input');
  const list = document.getElementById('branch-picker-list');
  if (!overlay) return;

  // Click en el overlay oscuro → cerrar
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeBranchPicker();
  });

  // Búsqueda incremental: re-renderizar la lista en cada keystroke
  input.addEventListener('input', () => {
    _branchPickerSelected = 0;
    renderBranchList(input.value);
  });

  // Navegación por teclado dentro de la lista
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.branch-item');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _branchPickerSelected = Math.min(_branchPickerSelected + 1, items.length - 1);
      renderBranchList(input.value);
      items[_branchPickerSelected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _branchPickerSelected = Math.max(_branchPickerSelected - 1, 0);
      renderBranchList(input.value);
      items[_branchPickerSelected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = list.querySelector('.branch-item.selected');
      if (selected) {
        const branch = selected.dataset.branch;
        // No hacer checkout si ya estamos en esa rama
        if (branch !== _branchPickerData.current) {
          checkoutBranch(branch);
        }
      }
    } else if (e.key === 'Escape') {
      closeBranchPicker();
    }
  });

  // Click directo en un item de la lista
  list.addEventListener('click', (e) => {
    const item = e.target.closest('.branch-item');
    if (!item) return;
    const branch = item.dataset.branch;
    if (branch !== _branchPickerData.current) {
      checkoutBranch(branch);
    }
  });
})();

/**
 * Sidebar resizable por drag.
 *
 * El handle es una franja de 4px en el borde derecho del sidebar
 * (posicionada con margin-left negativo para que se superponga al borde).
 *
 * Al hacer mousedown arranca el drag:
 * 1. Desactiva la transición CSS del sidebar para que no haya delay
 * 2. En cada mousemove calcula el nuevo ancho (clamp entre 150 y 600px)
 * 3. Al soltar restaura la transición y reajusta el layout de Monaco
 */
function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');
  let startX, startWidth;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    handle.classList.add('dragging');
    sidebar.style.transition = 'none'; // Sin animación durante el drag

    function onMouseMove(e) {
      const newWidth = Math.max(150, Math.min(600, startWidth + (e.clientX - startX)));
      sidebar.style.width = `${newWidth}px`;
    }

    function onMouseUp() {
      handle.classList.remove('dragging');
      sidebar.style.transition = ''; // Restaurar transición CSS
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // Monaco necesita saber que cambió el tamaño del contenedor
      if (state.editor) state.editor.layout();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

/**
 * Alterna la visibilidad del tab de terminal.
 * Si no hay terminales, crea la primera instancia.
 */
function toggleTerminal() {
  const existing = state.openTabs.find((t) => t.path === '__terminal__');
  if (existing) {
    if (state.activeTab === existing) {
      closeTab('__terminal__');
    } else {
      activateTab(existing);
    }
  } else {
    // Abrir como tab nuevo y crear la primera instancia de terminal
    const tab = {
      path: '__terminal__',
      name: 'Terminal',
      model: null,
      language: 'terminal',
      modified: false,
    };
    state.openTabs.push(tab);
    activateTab(tab);
    // Si no hay terminales activas, crear una
    if (state.terminals.size === 0) {
      createTerminalInstance();
    } else {
      // Reactivar la terminal que estaba activa
      if (state.activeTerminalId) activateTerminalInstance(state.activeTerminalId);
    }
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
    header.addEventListener('click', (e) => {
      // No colapsar la sección si se clickeó el botón de collapse tree
      if (e.target.closest('.tree-action-btn')) return;
      header.classList.toggle('collapsed');
      header.closest('.sidebar-section').classList.toggle('collapsed');
    });
  });

  // Collapse all sub-folders in the file tree (keep root-level folders expanded)
  document.getElementById('btn-collapse-tree').addEventListener('click', (e) => {
    e.stopPropagation(); // No propagar al header (evita colapsar sección FILES)
    const tree = document.getElementById('file-tree');
    // Remover todos los .tree-children (sub-folders expandidos) del DOM.
    // Los click handlers leen el estado del chevron, así que queda sincronizado.
    const allChildren = tree.querySelectorAll('.tree-children');
    allChildren.forEach(c => c.remove());
    // Resetear todos los chevrons de carpetas a collapsed (▸), excepto depth 0
    tree.querySelectorAll('.tree-item').forEach(item => {
      const chevron = item.querySelector('.tree-chevron');
      if (chevron && chevron.textContent === '▾' && parseInt(item.style.paddingLeft) > 12) {
        chevron.textContent = '▸';
      }
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

// ─── Model & Method call highlighting ───
let modelDecorationCollection = null;
function highlightModelCalls() {
  if (!state.editor) return;
  const model = state.editor.getModel();
  if (!model) return;

  const decorations = [];
  const text = model.getValue();
  // Clase::metodo  (static call — PascalCase class name)
  const staticRe = /\b([A-Z][A-Za-z0-9_]+)\s*::\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
  // $var->metodo   (instance call)
  const instanceRe = /(\$[a-zA-Z_][a-zA-Z0-9_]*)\s*->\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;

  const addMatch = (re) => {
    let m;
    while ((m = re.exec(text)) !== null) {
      const startPos = model.getPositionAt(m.index);
      const classEnd = model.getPositionAt(m.index + m[1].length);
      const methodStart = model.getPositionAt(m.index + m[0].lastIndexOf(m[2]));
      const methodEnd = model.getPositionAt(m.index + m[0].lastIndexOf(m[2]) + m[2].length);

      decorations.push({
        range: new monaco.Range(startPos.lineNumber, startPos.column, classEnd.lineNumber, classEnd.column),
        options: { inlineClassName: 'model-name-highlight' },
      });
      decorations.push({
        range: new monaco.Range(methodStart.lineNumber, methodStart.column, methodEnd.lineNumber, methodEnd.column),
        options: { inlineClassName: 'model-method-highlight' },
      });
    }
  };

  addMatch(staticRe);
  addMatch(instanceRe);

  // const NOMBRE = ... (class constants y globales)
  const constRe = /\bconst\s+([A-Z_][A-Z0-9_]*)\b/g;
  let cm;
  while ((cm = constRe.exec(text)) !== null) {
    const nameStart = model.getPositionAt(cm.index + cm[0].indexOf(cm[1]));
    const nameEnd = model.getPositionAt(cm.index + cm[0].indexOf(cm[1]) + cm[1].length);
    decorations.push({
      range: new monaco.Range(nameStart.lineNumber, nameStart.column, nameEnd.lineNumber, nameEnd.column),
      options: { inlineClassName: 'const-name-highlight' },
    });
  }

  if (!modelDecorationCollection) {
    modelDecorationCollection = state.editor.createDecorationsCollection(decorations);
  } else {
    modelDecorationCollection.set(decorations);
  }
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

/**
 * Oculta todos los paneles del sidebar y limpia el timer de git.
 * Punto central para el switch de vistas — cada showXxxPanel()
 * llama primero a esta función antes de mostrar su panel.
 */
function hideAllSidebarPanels() {
  document.getElementById('explorer-sections').style.display = 'none';
  document.getElementById('git-panel').style.display = 'none';
  document.getElementById('search-panel').style.display = 'none';
  document.getElementById('log-panel').style.display = 'none';
  document.getElementById('claude-panel').style.display = 'none';
  document.getElementById('debug-panel').style.display = 'none';
  if (state.gitRefreshTimer) {
    clearInterval(state.gitRefreshTimer);
    state.gitRefreshTimer = null;
  }
}

function showExplorerPanel() {
  state.sidebarView = 'explorer';
  hideAllSidebarPanels();
  document.getElementById('explorer-sections').style.display = '';
  document.getElementById('sidebar-header').querySelector('span').textContent =
    state.currentFolder
      ? state.currentFolder.split(/[/\\]/).pop().toUpperCase()
      : 'EXPLORER';
  setActiveActionButton(null);
}

function showGitPanel() {
  state.sidebarView = 'git';
  hideAllSidebarPanels();
  document.getElementById('git-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent =
    'SOURCE CONTROL';
  setActiveActionButton('btn-toggle-git');
  refreshGitStatus();
  state.gitRefreshTimer = setInterval(refreshGitStatus, 5000);
}

/**
 * Alterna la visibilidad del panel de debug Xdebug.
 * Si ya está activo, vuelve al explorer.
 */
function toggleDebugPanel() {
  if (state.sidebarView === 'debug') showExplorerPanel();
  else showDebugPanel();
}

/**
 * Muestra el panel de debug Xdebug en el sidebar.
 * Renderiza la lista de breakpoints al abrirse.
 */
function showDebugPanel() {
  state.sidebarView = 'debug';
  hideAllSidebarPanels();
  document.getElementById('debug-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent = 'DEBUG';
  setActiveActionButton('btn-debug-panel');
  renderDebugBreakpointsList();
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
  generation: 0,
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
  hideAllSidebarPanels();
  document.getElementById('search-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent = 'SEARCH';
  setActiveActionButton('btn-toggle-search');

  // Hacer visible el sidebar si estaba oculto
  if (!state.sidebarVisible) {
    toggleSidebar();
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

  // Incrementar generación para descartar resultados de búsquedas anteriores.
  // Si el usuario escribe "rdx" lento, se lanzan búsquedas para "r", "rd", "rdx".
  // La búsqueda de "r" (miles de matches) puede tardar más que "rdx" (pocos matches).
  // Sin este guard, los resultados de "r" llegarían después y pisarían los de "rdx".
  const gen = ++searchState.generation;

  document.getElementById('search-status').textContent = 'Searching...';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-collapse-all').textContent = '⊟';

  const result = await window.api.searchInFiles(state.currentFolder, query, {
    isRegex: searchState.isRegex,
    caseSensitive: searchState.caseSensitive,
  });

  // Descartar si ya se lanzó otra búsqueda más reciente
  if (gen !== searchState.generation) return;

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

  // Collapse/expand all search results
  const collapseBtn = document.getElementById('search-collapse-all');
  collapseBtn.addEventListener('click', () => {
    const groups = document.querySelectorAll('.search-file-group');
    const allCollapsed = [...groups].every(g => g.classList.contains('collapsed'));
    groups.forEach(g => g.classList.toggle('collapsed', !allCollapsed));
    collapseBtn.textContent = allCollapsed ? '⊟' : '⊞';
  });

  // Sidebar button
  document.getElementById('btn-toggle-search').addEventListener('click', () => toggleSearchPanel());

  // Menu/keyboard shortcut
  window.api.onMenuSearch(() => showSearchPanel());
}

async function refreshGitStatus() {
  if (!state.currentFolder) return;

  // Cachear la raíz del repo para blame y otras operaciones git
  if (!state.gitRepoRoot) {
    const rootResult = await window.api.gitRootDir(state.currentFolder);
    if (!rootResult.error) state.gitRepoRoot = rootResult.output;
  }

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

  // Actualizar badge en el icono de Source Control
  const totalChanges = (files.staged?.length || 0) + (files.unstaged?.length || 0) + (files.untracked?.length || 0) + (files.conflicted?.length || 0);
  const gitBtn = document.getElementById('btn-toggle-git');
  let badge = gitBtn.querySelector('.action-badge');
  if (totalChanges > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'action-badge';
      gitBtn.appendChild(badge);
    }
    badge.textContent = totalChanges > 99 ? '99+' : totalChanges;
  } else if (badge) {
    badge.remove();
  }
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
      const statusLabel = type === 'conflicted' ? '!' : file.status[0].toUpperCase();
      const deletedClass = file.status === 'deleted' ? ' git-file-deleted' : '';
      const statusClass = type === 'conflicted' ? 'conflict' : file.status;

      let buttons = '';
      if (type === 'conflicted') {
        // Conflictos: abrir resolver + botón para marcar resuelto (stage)
        buttons = `<button class="git-action-btn" data-action="stage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Mark as Resolved (stage)">✓</button>`;
      } else if (type === 'staged') {
        buttons = `<button class="git-action-btn" data-action="unstage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Unstage">−</button>`;
      } else if (type === 'unstaged') {
        buttons = `<button class="git-action-btn" data-action="stage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Stage">+</button>
          <button class="git-action-btn" data-action="discard" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Discard">↺</button>`;
      } else {
        buttons = `<button class="git-action-btn" data-action="stage" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" title="Stage">+</button>`;
      }

      return `<div class="git-file-item">
        <span class="git-file-name${deletedClass}" data-type="${type}" data-path="${escapeAttr(file.path)}" data-abs="${escapeAttr(file.absolutePath)}" data-status="${file.status}" title="${escapeAttr(file.path)}">${escapeHtml(fileName)}</span>
        <span class="git-file-status git-status-${statusClass}">${statusLabel}</span>
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
    buildSection('Merge Conflicts', files.conflicted || [], 'conflicted') +
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

// ┌──────────────────────────────────────────────────┐
// │  7e. GIT CONFLICT RESOLVER (3-pane, PhpStorm)    │
// │  Tres paneles: Yours (ours) | Result | Theirs.   │
// │  El panel central es editable — el usuario       │
// │  construye el merge final aceptando hunks de     │
// │  cada lado o editando directamente. Al guardar   │
// │  se escribe el resultado y se stagea el archivo. │
// └──────────────────────────────────────────────────┘

/**
 * Genera el contenido inicial del panel Result a partir del archivo
 * con marcadores de conflicto. Limpia los marcadores (<<<<<<<, =======,
 * >>>>>>>) y conserva ambas versiones separadas por una línea vacía
 * para que el usuario pueda editar el merge manualmente.
 *
 * @param {string} raw - Contenido del archivo con marcadores de conflicto
 * @returns {string} Contenido limpio con ambas versiones visibles
 */
function buildInitialResult(raw) {
  const lines = raw.split('\n');
  const out = [];
  let inConflict = false;
  let section = null; // 'ours' o 'theirs'

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      section = 'ours';
      out.push('// ── YOURS ──────────────────────────');
      continue;
    }
    if (line.startsWith('=======') && inConflict) {
      section = 'theirs';
      out.push('// ── THEIRS ─────────────────────────');
      continue;
    }
    if (line.startsWith('>>>>>>>') && inConflict) {
      inConflict = false;
      section = null;
      out.push('// ── END CONFLICT ───────────────────');
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Abre el conflict resolver de 3 paneles estilo PhpStorm.
 *
 * Layout:
 *  ┌──────────────┬──────────────┬──────────────┐
 *  │  Yours (L)   │  Result (C)  │  Theirs (R)  │
 *  │  read-only   │  editable    │  read-only   │
 *  └──────────────┴──────────────┴──────────────┘
 *
 * Toolbar superior con botones Accept Left / Accept Right (archivo
 * completo) y "Apply & Resolve" que escribe el contenido del panel
 * central al disco y lo stagea.
 *
 * @param {string} relativePath - Path relativo al repo
 * @param {string} absolutePath - Path absoluto en disco
 * @param {string} fileName - Nombre del archivo
 */
async function openConflictView(relativePath, absolutePath, fileName) {
  const conflictId = `__conflict__${relativePath}`;

  // Si ya está abierto, activar
  const existing = state.openTabs.find((t) => t.path === conflictId);
  if (existing) {
    activateTab(existing);
    return;
  }

  // Obtener las tres versiones del conflicto en paralelo
  const [oursResult, theirsResult, currentResult] = await Promise.all([
    window.api.gitConflictContent(state.currentFolder, relativePath, 'ours'),
    window.api.gitConflictContent(state.currentFolder, relativePath, 'theirs'),
    window.api.readFile(absolutePath),
  ]);

  const oursContent = oursResult.error ? '' : oursResult.output;
  const theirsContent = theirsResult.error ? '' : theirsResult.output;
  const currentContent = currentResult.error ? '' : currentResult.content;

  // El panel central empieza con el contenido limpio (sin marcadores)
  const resultContent = buildInitialResult(currentContent);

  const ext = fileName.split('.').pop();
  const language = getMonacoLanguage(ext);
  const theme = document.documentElement.getAttribute('data-theme') === 'light'
    ? 'mojavecode-php-light' : 'mojavecode-php-dark';

  // Limpiar conflict editors anteriores
  const prevConflict = state.openTabs.find((t) => t.path.startsWith('__conflict__') && t.conflictEditors);
  if (prevConflict) {
    prevConflict.conflictEditors.forEach((ed) => { try { ed.dispose(); } catch { /* ok */ } });
    prevConflict.diffModels.forEach((m) => { try { m.dispose(); } catch { /* ok */ } });
    prevConflict.conflictEditors = null;
    prevConflict.diffModels = null;
  }

  const container = document.getElementById('diff-container');
  container.innerHTML = '';

  // ── Toolbar de resolución ──────────────────────────────────
  const toolbar = document.createElement('div');
  toolbar.className = 'conflict-toolbar';
  toolbar.innerHTML = `
    <span class="conflict-toolbar-label">⚡ Merge Conflict — ${escapeHtml(fileName)}</span>
    <button class="conflict-btn conflict-btn-ours" data-action="accept-left" title="Replace result with Yours (current branch)">Accept Left</button>
    <button class="conflict-btn conflict-btn-theirs" data-action="accept-right" title="Replace result with Theirs (incoming branch)">Accept Right</button>
    <button class="conflict-btn conflict-btn-resolve" data-action="resolve" title="Save result and mark as resolved">Apply &amp; Resolve</button>
  `;
  container.appendChild(toolbar);

  // ── Cabeceras de los 3 paneles ─────────────────────────────
  const headers = document.createElement('div');
  headers.className = 'conflict-headers';
  headers.innerHTML = `
    <span class="conflict-header conflict-header-ours">Yours (Current Branch)</span>
    <span class="conflict-header conflict-header-result">Result</span>
    <span class="conflict-header conflict-header-theirs">Theirs (Incoming)</span>
  `;
  container.appendChild(headers);

  // ── 3 paneles de editor ────────────────────────────────────
  const panes = document.createElement('div');
  panes.className = 'conflict-panes';
  container.appendChild(panes);

  const editorOpts = {
    theme,
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
    glyphMargin: false,
    folding: false,
    renderLineHighlight: 'none',
  };

  // Panel izquierdo — Yours (read-only)
  const leftPane = document.createElement('div');
  leftPane.className = 'conflict-pane conflict-pane-left';
  panes.appendChild(leftPane);

  const oursModel = monaco.editor.createModel(oursContent, language);
  const oursEditor = monaco.editor.create(leftPane, { ...editorOpts, readOnly: true, domReadOnly: true });
  oursEditor.setModel(oursModel);

  // Panel central — Result (editable)
  const centerPane = document.createElement('div');
  centerPane.className = 'conflict-pane conflict-pane-center';
  panes.appendChild(centerPane);

  const resultModel = monaco.editor.createModel(resultContent, language);
  const resultEditor = monaco.editor.create(centerPane, { ...editorOpts, readOnly: false });
  resultEditor.setModel(resultModel);

  // Panel derecho — Theirs (read-only)
  const rightPane = document.createElement('div');
  rightPane.className = 'conflict-pane conflict-pane-right';
  panes.appendChild(rightPane);

  const theirsModel = monaco.editor.createModel(theirsContent, language);
  const theirsEditor = monaco.editor.create(rightPane, { ...editorOpts, readOnly: true, domReadOnly: true });
  theirsEditor.setModel(theirsModel);

  // ── Sincronizar scroll entre los 3 paneles ─────────────────
  let scrolling = false;
  function syncScroll(source, targets) {
    if (scrolling) return;
    scrolling = true;
    const top = source.getScrollTop();
    targets.forEach((t) => t.setScrollTop(top));
    scrolling = false;
  }
  oursEditor.onDidScrollChange(() => syncScroll(oursEditor, [resultEditor, theirsEditor]));
  resultEditor.onDidScrollChange(() => syncScroll(resultEditor, [oursEditor, theirsEditor]));
  theirsEditor.onDidScrollChange(() => syncScroll(theirsEditor, [oursEditor, resultEditor]));

  // ── Event handlers para los botones ────────────────────────
  toolbar.addEventListener('click', async (e) => {
    const btn = e.target.closest('.conflict-btn');
    if (!btn) return;

    const action = btn.dataset.action;

    if (action === 'accept-left') {
      resultModel.setValue(oursContent);
      return;
    }
    if (action === 'accept-right') {
      resultModel.setValue(theirsContent);
      return;
    }

    if (action === 'resolve') {
      const finalContent = resultModel.getValue();
      btn.textContent = 'Resolving...';
      btn.disabled = true;

      const result = await window.api.gitConflictResolve(state.currentFolder, relativePath, finalContent);
      if (result.error) {
        alert(`Failed to resolve conflict:\n${result.error}`);
        btn.innerHTML = 'Apply &amp; Resolve';
        btn.disabled = false;
        return;
      }

      closeTab(conflictId);
      refreshGitStatus();
    }
  });

  // ── Crear el tab ───────────────────────────────────────────
  const tab = {
    path: conflictId,
    name: `${fileName} (Conflict)`,
    model: null,
    language,
    modified: false,
    conflictEditors: [oursEditor, resultEditor, theirsEditor],
    diffModels: [oursModel, resultModel, theirsModel],
  };

  state.openTabs.push(tab);
  activateTab(tab);
}

// ┌──────────────────────────────────────────────────┐
// │  7f. GIT STASH UI                                │
// │  Overlay para listar, crear, aplicar, pop y      │
// │  eliminar stashes. Sigue el patrón del Branch    │
// │  Picker: overlay oscuro + caja centrada.         │
// └──────────────────────────────────────────────────┘

/**
 * Abre el overlay de stashes. Carga la lista de stashes y la renderiza.
 * El botón "New Stash" permite guardar los cambios actuales.
 */
async function showStashOverlay() {
  const overlay = document.getElementById('stash-overlay');
  overlay.style.display = 'flex';

  await renderStashList();

  // Cerrar con Escape
  const onKey = (e) => {
    if (e.key === 'Escape') {
      closeStashOverlay();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);

  // Cerrar al clickear el backdrop
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeStashOverlay();
  }, { once: true });

  // Botón "+ New Stash"
  const saveBtn = document.getElementById('stash-save-btn');
  // Remover handler anterior para evitar duplicados
  const newSaveBtn = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
  newSaveBtn.addEventListener('click', stashSave);
}

function closeStashOverlay() {
  document.getElementById('stash-overlay').style.display = 'none';
}

/**
 * Carga y renderiza la lista de stashes en el overlay.
 */
async function renderStashList() {
  const list = document.getElementById('stash-list');
  const empty = document.getElementById('stash-empty');
  list.innerHTML = '<div class="stash-loading">Loading stashes...</div>';
  empty.style.display = 'none';

  const result = await window.api.gitStashList(state.currentFolder);

  if (result.error || !result.stashes || result.stashes.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = result.stashes.map((s) => `
    <div class="stash-item" data-ref="${escapeAttr(s.ref)}">
      <div class="stash-item-info">
        <span class="stash-item-ref">${escapeHtml(s.ref)}</span>
        <span class="stash-item-message">${escapeHtml(s.message)}</span>
        <span class="stash-item-date">${escapeHtml(s.date)}</span>
      </div>
      <div class="stash-item-actions">
        <button class="stash-action-btn stash-btn-apply" data-action="apply" data-ref="${escapeAttr(s.ref)}" title="Apply (keep in stash list)">Apply</button>
        <button class="stash-action-btn stash-btn-pop" data-action="pop" data-ref="${escapeAttr(s.ref)}" title="Apply and remove from stash list">Pop</button>
        <button class="stash-action-btn stash-btn-drop" data-action="drop" data-ref="${escapeAttr(s.ref)}" title="Delete this stash">Drop</button>
      </div>
    </div>
  `).join('');

  // Event delegation para los botones de acción
  list.onclick = async (e) => {
    const btn = e.target.closest('.stash-action-btn');
    if (!btn) return;

    const action = btn.dataset.action;
    const ref = btn.dataset.ref;

    if (action === 'drop') {
      if (!confirm(`Delete ${ref}? This cannot be undone.`)) return;
    }

    btn.textContent = '...';
    btn.disabled = true;

    let result;
    if (action === 'apply') {
      result = await window.api.gitStashApply(state.currentFolder, ref);
    } else if (action === 'pop') {
      result = await window.api.gitStashPop(state.currentFolder, ref);
    } else if (action === 'drop') {
      result = await window.api.gitStashDrop(state.currentFolder, ref);
    }

    if (result.error) {
      alert(`Stash ${action} failed:\n${result.error}`);
      btn.textContent = action.charAt(0).toUpperCase() + action.slice(1);
      btn.disabled = false;
      return;
    }

    // Refrescar la lista y el git status
    await renderStashList();
    refreshGitStatus();
  };
}

/**
 * Guarda los cambios actuales en un nuevo stash.
 * Muestra un prompt para un mensaje opcional.
 */
async function stashSave() {
  const message = prompt('Stash message (optional):');
  if (message === null) return; // cancelled

  const includeUntracked = document.getElementById('stash-include-untracked')?.checked ?? true;
  const btn = document.getElementById('stash-save-btn');
  btn.textContent = 'Stashing...';
  btn.disabled = true;

  const result = await window.api.gitStashSave(state.currentFolder, message || '', includeUntracked);

  btn.textContent = '+ New Stash';
  btn.disabled = false;

  if (result.error) {
    alert(`Stash failed:\n${result.error}`);
    return;
  }

  await renderStashList();
  refreshGitStatus();
}

// ┌──────────────────────────────────────────────────┐
// │  7h. XDEBUG INTEGRATION                         │
// │  Breakpoints en el gutter, toolbar de control,   │
// │  panel de variables, call stack, y listener TCP. │
// │  Usa el protocolo DBGp para comunicarse con      │
// │  Xdebug via xdebug-manager.js en el main.       │
// └──────────────────────────────────────────────────┘

// ── Breakpoint state ─────────────────────────────────────────
// { filePath: Set<lineNumber> } — persiste en localStorage
state.breakpoints = {};
state.debugState = 'idle';
state.debugCurrentLineDecos = [];
state.debugXdebugBreakpointIds = {}; // { "file:line": xdebugId }

/**
 * Carga breakpoints desde localStorage al iniciar la app.
 */
function loadBreakpoints() {
  try {
    const saved = localStorage.getItem('mojavecode-breakpoints');
    if (saved) {
      const parsed = JSON.parse(saved);
      for (const [filePath, lines] of Object.entries(parsed)) {
        state.breakpoints[filePath] = new Set(lines);
      }
    }
  } catch { /* ok */ }
}

/**
 * Persiste breakpoints a localStorage.
 */
function saveBreakpoints() {
  const serialized = {};
  for (const [filePath, lines] of Object.entries(state.breakpoints)) {
    if (lines.size > 0) serialized[filePath] = [...lines];
  }
  localStorage.setItem('mojavecode-breakpoints', JSON.stringify(serialized));
  // Sincronizar al main process para auto-setup inmediato al conectar
  window.api.xdebugSyncBreakpoints(serialized);
}

/**
 * Agrega o quita un breakpoint en una línea. Actualiza decoraciones,
 * persiste en localStorage, y si hay sesión de debug activa, lo
 * envía a Xdebug via IPC.
 *
 * @param {string} filePath - Path absoluto del archivo
 * @param {number} line - Número de línea
 */
function toggleBreakpoint(filePath, line) {
  if (!state.breakpoints[filePath]) state.breakpoints[filePath] = new Set();

  if (state.breakpoints[filePath].has(line)) {
    state.breakpoints[filePath].delete(line);
    // Quitar de Xdebug si hay sesión activa
    const key = `${filePath}:${line}`;
    if (state.debugXdebugBreakpointIds[key]) {
      window.api.xdebugRemoveBreakpoint(state.debugXdebugBreakpointIds[key]);
      delete state.debugXdebugBreakpointIds[key];
    }
  } else {
    state.breakpoints[filePath].add(line);
    // Enviar a Xdebug si hay sesión activa
    if (state.debugState === 'connected' || state.debugState === 'break') {
      window.api.xdebugSetBreakpoint(filePath, line).then((res) => {
        if (res.id) state.debugXdebugBreakpointIds[`${filePath}:${line}`] = res.id;
      });
    }
  }

  saveBreakpoints();
  renderBreakpointDecorations();
  renderDebugBreakpointsList();
}

/**
 * Renderiza las decoraciones de breakpoints (puntos rojos) en el editor
 * para el archivo activo.
 */
function renderBreakpointDecorations() {
  if (!state.editor || !state.activeTab || state.activeTab.path.startsWith('__')) return;

  const filePath = state.activeTab.path;
  const lines = state.breakpoints[filePath];
  const decos = [];

  if (lines) {
    for (const line of lines) {
      decos.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: 'debug-breakpoint',
          stickiness: 1, // NeverGrowsWhenTypingAtEdges
        },
      });
    }
  }

  state._breakpointDecos = state.editor.deltaDecorations(state._breakpointDecos || [], decos);
}

/**
 * Renderiza la lista de breakpoints en el panel lateral de debug.
 */
function renderDebugBreakpointsList() {
  const list = document.getElementById('debug-breakpoints-list');
  if (!list) return;

  const allBps = [];
  for (const [filePath, lines] of Object.entries(state.breakpoints)) {
    for (const line of lines) {
      const fileName = filePath.split(/[/\\]/).pop();
      allBps.push({ filePath, line, fileName });
    }
  }

  if (allBps.length === 0) {
    list.innerHTML = '<div class="debug-empty">No breakpoints</div>';
    return;
  }

  list.innerHTML = allBps.map((bp) => `
    <div class="debug-bp-item" data-file="${escapeAttr(bp.filePath)}" data-line="${bp.line}">
      <span class="debug-bp-dot"></span>
      <span class="debug-bp-file">${escapeHtml(bp.fileName)}</span>
      <span class="debug-bp-line">:${bp.line}</span>
      <button class="debug-bp-remove" data-file="${escapeAttr(bp.filePath)}" data-line="${bp.line}" title="Remove">×</button>
    </div>
  `).join('');

  // Click para navegar al breakpoint
  list.querySelectorAll('.debug-bp-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.debug-bp-remove')) return;
      const fp = el.dataset.file;
      const ln = parseInt(el.dataset.line, 10);
      const fileName = fp.split(/[/\\]/).pop();
      openFile(fp, fileName).then(() => {
        state.editor.revealLineInCenter(ln);
        state.editor.setPosition({ lineNumber: ln, column: 1 });
      });
    });
  });

  // Botón X para eliminar
  list.querySelectorAll('.debug-bp-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleBreakpoint(btn.dataset.file, parseInt(btn.dataset.line, 10));
    });
  });
}

/**
 * Inicializa el gutter click handler para breakpoints y
 * los event listeners del debug panel.
 */
function initDebugPanel() {
  // ── Gutter click → toggle breakpoint ───────────────────────
  state.editor.onMouseDown((e) => {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      if (!state.activeTab || state.activeTab.path.startsWith('__')) return;
      toggleBreakpoint(state.activeTab.path, e.target.position.lineNumber);
    }
  });

  // Cargar breakpoints persistidos y sincronizar al main process
  loadBreakpoints();
  saveBreakpoints(); // sync al main para auto-setup

  // ── Debug panel button ─────────────────────────────────────
  document.getElementById('btn-debug-panel')?.addEventListener('click', toggleDebugPanel);

  // ── Listen button ──────────────────────────────────────────
  const listenBtn = document.getElementById('debug-listen-btn');
  listenBtn.addEventListener('click', async () => {
    if (state.debugState === 'idle' || state.debugState === 'stopped') {
      // Construir path mappings para Docker/Sail
      const mappings = [];
      if (state.projectCaps?.hasSail && state.projectCaps?.sailEnabled) {
        mappings.push({ remote: '/var/www/html', local: state.projectCaps.projectRoot });
      } else if (state.projectCaps?.hasDocker && state.projectCaps?.dockerWorkdir && state.projectCaps?.projectRoot) {
        mappings.push({ remote: state.projectCaps.dockerWorkdir, local: state.projectCaps.projectRoot });
      }
      await window.api.xdebugStartListening(9003, mappings);
    } else {
      await window.api.xdebugStopListening();
    }
  });

  // ── Step controls ──────────────────────────────────────────
  document.getElementById('debug-continue')?.addEventListener('click', () => window.api.xdebugRun());
  document.getElementById('debug-step-over')?.addEventListener('click', () => window.api.xdebugStepOver());
  document.getElementById('debug-step-into')?.addEventListener('click', () => window.api.xdebugStepInto());
  document.getElementById('debug-step-out')?.addEventListener('click', () => window.api.xdebugStepOut());
  document.getElementById('debug-stop')?.addEventListener('click', () => window.api.xdebugStop());

  // ── Section collapse ───────────────────────────────────────
  document.querySelectorAll('.debug-section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const chevron = header.querySelector('.debug-section-chevron');
      const body = header.nextElementSibling;
      chevron?.classList.toggle('collapsed');
      body?.classList.toggle('collapsed');
    });
  });

  // ── Variable search filter ──────────────────────────────────
  const varSearchInput = document.getElementById('debug-var-search');
  if (varSearchInput) {
    varSearchInput.addEventListener('input', () => {
      const query = varSearchInput.value.toLowerCase();
      _renderFilteredVariables(state._debugContexts || [], query);
    });
  }

  // ── Keyboard shortcuts ─────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (state.debugState !== 'break' && state.debugState !== 'running') return;
    if (e.key === 'F5' && !e.shiftKey) { e.preventDefault(); window.api.xdebugRun(); }
    else if (e.key === 'F10') { e.preventDefault(); window.api.xdebugStepOver(); }
    else if (e.key === 'F11' && !e.shiftKey) { e.preventDefault(); window.api.xdebugStepInto(); }
    else if (e.key === 'F11' && e.shiftKey) { e.preventDefault(); window.api.xdebugStepOut(); }
    else if (e.key === 'F5' && e.shiftKey) { e.preventDefault(); window.api.xdebugStop(); }
  });

  // ── Xdebug events ─────────────────────────────────────────
  window.api.onXdebugStateChanged(({ state: newState }) => {
    state.debugState = newState;
    updateDebugUI();
  });

  // Init se maneja en el main process: auto-setea breakpoints y run
  // sin pasar por IPC para evitar que scripts cortos terminen antes.
  window.api.onXdebugInit(() => {
    // Solo actualizar UI — breakpoints y run ya se enviaron desde main
  });

  window.api.onXdebugBreak(async ({ file, line }) => {
    console.log(`[Debug] Break at ${file}:${line}`);

    // Abrir archivo y resaltar línea actual
    try {
      const fileName = file.split(/[/\\]/).pop();
      await openFile(file, fileName);
      state.editor.revealLineInCenter(line);
      state.editor.setPosition({ lineNumber: line, column: 1 });

      // Decoración de línea actual (flecha amarilla)
      state.debugCurrentLineDecos = state.editor.deltaDecorations(state.debugCurrentLineDecos || [], [
        {
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: 'debug-current-line',
            glyphMarginClassName: 'debug-current-arrow',
          },
        },
      ]);
    } catch (err) {
      console.warn('[Debug] Failed to open file:', err);
    }

    // Cargar variables y call stack (siempre, incluso si openFile falló)
    await loadDebugData();
  });

  window.api.onXdebugSessionEnd(() => {
    clearDebugHighlight();
    state._debugContexts = [];
    const varSearch = document.getElementById('debug-var-search');
    if (varSearch) varSearch.value = '';
    document.getElementById('debug-variables-list').innerHTML = '<div class="debug-empty">Session ended</div>';
    document.getElementById('debug-callstack-list').innerHTML = '<div class="debug-empty">Session ended</div>';
  });
}

/**
 * Actualiza la UI del debug panel según el estado actual.
 */
function updateDebugUI() {
  const statusText = document.getElementById('debug-status-text');
  const statusBar = document.getElementById('status-debug');
  const listenBtn = document.getElementById('debug-listen-btn');
  const toolbar = document.getElementById('debug-toolbar-inline');

  const labels = {
    idle: 'Idle', listening: 'Listening...', connected: 'Connected',
    break: 'Paused', running: 'Running', stopped: 'Stopped',
  };
  const colors = {
    idle: 'var(--text-muted)', listening: 'var(--accent-yellow)',
    connected: 'var(--accent-green)', break: '#ffcc33',
    running: 'var(--accent-green)', stopped: 'var(--accent-red)',
  };

  if (statusText) statusText.textContent = labels[state.debugState] || state.debugState;
  if (statusBar) {
    statusBar.textContent = state.debugState !== 'idle' ? `● ${labels[state.debugState]}` : '';
    statusBar.style.color = colors[state.debugState] || '';
  }

  // Listen button
  if (listenBtn) {
    if (state.debugState === 'idle' || state.debugState === 'stopped') {
      listenBtn.textContent = 'Listen';
      listenBtn.className = '';
    } else {
      listenBtn.textContent = 'Stop';
      listenBtn.className = 'debug-listen-active';
    }
  }

  // Toolbar de step controls
  if (toolbar) {
    toolbar.style.display = (state.debugState === 'break' || state.debugState === 'running') ? 'flex' : 'none';
  }
}

/**
 * Limpia la decoración de línea actual del debugger.
 */
function clearDebugHighlight() {
  if (state.editor && state.debugCurrentLineDecos.length) {
    state.debugCurrentLineDecos = state.editor.deltaDecorations(state.debugCurrentLineDecos, []);
  }
}

/**
 * Carga variables y call stack desde Xdebug y los renderiza.
 * Se llama en cada break (breakpoint, step over, step into, step out).
 */
async function loadDebugData() {
  try {
    // Call stack
    const stack = await window.api.xdebugGetStack();
    renderDebugCallStack(Array.isArray(stack) ? stack : []);
  } catch (err) {
    console.warn('[Debug] Failed to load call stack:', err);
  }

  try {
    // Variables — obtener todos los contextos del frame 0
    const contexts = await window.api.xdebugGetContextNames(0);
    if (Array.isArray(contexts)) {
      const allVars = [];
      for (const ctx of contexts) {
        try {
          const vars = await window.api.xdebugGetContext(ctx.id, 0);
          allVars.push({ name: ctx.name, id: ctx.id, variables: Array.isArray(vars) ? vars : [] });
        } catch { /* contexto sin variables */ }
      }
      renderDebugVariables(allVars);
    }
  } catch (err) {
    console.warn('[Debug] Failed to load variables:', err);
  }
}

/**
 * Guarda los contextos actuales para re-filtrar sin pedir a Xdebug.
 */
state._debugContexts = [];

/**
 * Renderiza las variables en el panel de debug.
 * Cada contexto (Locals, Superglobals, Constants) es una sección
 * colapsable abierta por defecto. Soporta filtro de búsqueda.
 */
function renderDebugVariables(contexts) {
  state._debugContexts = contexts;

  const searchInput = document.getElementById('debug-var-search');
  const query = (searchInput?.value || '').toLowerCase();

  _renderFilteredVariables(contexts, query);
}

function _renderFilteredVariables(contexts, query) {
  const list = document.getElementById('debug-variables-list');
  if (!list) return;

  if (!contexts.length || contexts.every((c) => c.variables.length === 0)) {
    list.innerHTML = '<div class="debug-empty">No variables</div>';
    return;
  }

  // Recordar qué secciones estaban colapsadas
  const collapsedSections = new Set();
  list.querySelectorAll('.debug-ctx-header.collapsed').forEach((el) => {
    collapsedSections.add(el.dataset.ctxId);
  });

  list.innerHTML = contexts.map((ctx) => {
    // Filtrar variables por query (nombre o valor)
    const filtered = query
      ? ctx.variables.filter((v) => _varMatchesQuery(v, query))
      : ctx.variables;
    if (filtered.length === 0) return '';

    const isCollapsed = !query && collapsedSections.has(String(ctx.id));
    return `
      <div class="debug-ctx-section">
        <div class="debug-ctx-header${isCollapsed ? ' collapsed' : ''}" data-ctx-id="${ctx.id}">
          <span class="debug-ctx-chevron">${isCollapsed ? '▸' : '▾'}</span>
          <span class="debug-ctx-name">${escapeHtml(ctx.name)}</span>
          <span class="debug-ctx-count">${filtered.length}</span>
        </div>
        <div class="debug-ctx-body${isCollapsed ? ' collapsed' : ''}">
          ${filtered.map((v) => renderVariable(v, 0)).join('')}
        </div>
      </div>
    `;
  }).join('');

  // Collapse/expand de secciones de contexto
  list.querySelectorAll('.debug-ctx-header').forEach((header) => {
    header.addEventListener('click', () => {
      const isCollapsed = header.classList.toggle('collapsed');
      header.querySelector('.debug-ctx-chevron').textContent = isCollapsed ? '▸' : '▾';
      header.nextElementSibling.classList.toggle('collapsed', isCollapsed);
    });
  });

  // Expand/collapse para variables con hijos (objetos, arrays)
  _bindVarExpandables(list);
}

/**
 * Chequea si una variable matchea el query de búsqueda.
 * Busca en nombre, valor, y recursivamente en hijos.
 */
function _varMatchesQuery(v, query) {
  if (v.name.toLowerCase().includes(query)) return true;
  if (v.value && v.value.toLowerCase().includes(query)) return true;
  if (v.fullname && v.fullname.toLowerCase().includes(query)) return true;
  if (v.children && v.children.some((c) => _varMatchesQuery(c, query))) return true;
  return false;
}

/**
 * Bindea expand/collapse en variables con hijos (objetos, arrays).
 */
function _bindVarExpandables(container) {
  container.querySelectorAll('.debug-var-expandable').forEach((el) => {
    if (el._boundExpand) return;
    el._boundExpand = true;
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const childrenEl = el.nextElementSibling;
      if (!childrenEl?.classList.contains('debug-var-children')) return;

      const isOpen = childrenEl.style.display !== 'none';
      childrenEl.style.display = isOpen ? 'none' : '';
      el.querySelector('.debug-var-arrow').textContent = isOpen ? '▸' : '▾';

      // Lazy load si no hay hijos cargados
      if (!isOpen && childrenEl.children.length === 0) {
        const fullname = el.dataset.fullname;
        const ctxId = parseInt(el.closest('.debug-ctx-section')?.querySelector('.debug-ctx-header')?.dataset.ctxId || '0', 10);
        try {
          const result = await window.api.xdebugGetProperty(fullname, 0, ctxId);
          if (result?.children) {
            childrenEl.innerHTML = result.children.map((c) => renderVariable(c, parseInt(el.dataset.depth || '0') + 1)).join('');
            _bindVarExpandables(childrenEl);
          }
        } catch { /* ok */ }
      }
    });
  });
}

/**
 * Renderiza una variable individual (recursivo para hijos inline).
 */
function renderVariable(v, depth) {
  const indent = depth * 16;
  const typeClass = `debug-type-${v.type}`;
  const displayValue = v.type === 'string' ? `"${escapeHtml(v.value)}"` : escapeHtml(v.value || v.type);

  if (v.hasChildren) {
    const childrenHtml = v.children.length > 0
      ? v.children.map((c) => renderVariable(c, depth + 1)).join('')
      : '';
    return `
      <div class="debug-var-expandable" style="padding-left:${indent}px" data-fullname="${escapeAttr(v.fullname)}" data-depth="${depth}">
        <span class="debug-var-arrow">▸</span>
        <span class="debug-var-name">${escapeHtml(v.name)}</span>
        <span class="debug-var-type ${typeClass}">${escapeHtml(v.type)}${v.numChildren ? `(${v.numChildren})` : ''}</span>
      </div>
      <div class="debug-var-children" style="display:none">${childrenHtml}</div>
    `;
  }

  return `
    <div class="debug-var-item" style="padding-left:${indent}px">
      <span class="debug-var-name">${escapeHtml(v.name)}</span>
      <span class="debug-var-sep">=</span>
      <span class="debug-var-value ${typeClass}">${displayValue}</span>
    </div>
  `;
}

/**
 * Renderiza el call stack en el panel de debug.
 */
function renderDebugCallStack(frames) {
  const list = document.getElementById('debug-callstack-list');
  if (!list) return;

  if (!frames.length) {
    list.innerHTML = '<div class="debug-empty">No call stack</div>';
    return;
  }

  list.innerHTML = frames.map((f, i) => {
    const fileName = f.file.split(/[/\\]/).pop();
    return `
      <div class="debug-stack-item ${i === 0 ? 'debug-stack-active' : ''}" data-file="${escapeAttr(f.file)}" data-line="${f.line}" data-level="${f.level}">
        <span class="debug-stack-fn">${escapeHtml(f.where)}</span>
        <span class="debug-stack-loc">${escapeHtml(fileName)}:${f.line}</span>
      </div>
    `;
  }).join('');

  // Click para navegar al frame
  list.querySelectorAll('.debug-stack-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const fp = el.dataset.file;
      const ln = parseInt(el.dataset.line, 10);
      const fileName = fp.split(/[/\\]/).pop();
      await openFile(fp, fileName);
      state.editor.revealLineInCenter(ln);
      state.editor.setPosition({ lineNumber: ln, column: 1 });
    });
  });
}

// ┌──────────────────────────────────────────────────┐
// │  7g. ENV VIEWER                                  │
// │  Editor visual de archivos .env. Agrupa las      │
// │  variables por prefijo (APP_, DB_, MAIL_, etc.)  │
// │  y permite edición inline. Los cambios se        │
// │  guardan directo al archivo .env original.       │
// └──────────────────────────────────────────────────┘

/**
 * Parsea el contenido de un archivo .env en un array de entries.
 *
 * Preserva comentarios y líneas vacías como entries de tipo 'comment'
 * o 'blank' para poder reconstruir el archivo sin perder formato.
 * Las variables se parsean en entries de tipo 'var' con key y value.
 *
 * @param {string} raw - Contenido del archivo .env
 * @returns {Array<{type: string, key?: string, value?: string, raw: string}>}
 */
function parseEnvContent(raw) {
  const entries = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      entries.push({ type: 'blank', raw: line });
    } else if (trimmed.startsWith('#')) {
      entries.push({ type: 'comment', raw: line });
    } else {
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) {
        entries.push({ type: 'comment', raw: line });
      } else {
        const key = trimmed.substring(0, eqIdx).trim();
        let value = trimmed.substring(eqIdx + 1).trim();
        // Quitar comillas envolventes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        entries.push({ type: 'var', key, value, raw: line });
      }
    }
  }
  return entries;
}

/**
 * Reconstruye el contenido .env a partir de las entries modificadas.
 *
 * Preserva comentarios, líneas vacías y el orden original.
 * Solo las variables editadas se actualizan; el resto queda igual.
 *
 * @param {Array} entries - Array de entries parseadas
 * @returns {string} Contenido del .env para escribir al disco
 */
function serializeEnvContent(entries) {
  return entries.map((e) => {
    if (e.type !== 'var') return e.raw;
    // Valor con espacios o caracteres especiales → envolver en comillas
    const needsQuotes = /[\s#"'\\]/.test(e.value) || e.value === '';
    const val = needsQuotes ? `"${e.value}"` : e.value;
    return `${e.key}=${val}`;
  }).join('\n');
}

/**
 * Determina el grupo (sección) de una variable .env por su prefijo.
 *
 * Agrupa por prefijos comunes de Laravel: APP, DB, MAIL, CACHE,
 * REDIS, AWS, LOG, BROADCAST, QUEUE, SESSION, etc.
 * Variables sin prefijo conocido van al grupo "Other".
 *
 * @param {string} key - Nombre de la variable
 * @returns {string} Nombre del grupo
 */
function envGroupName(key) {
  const prefixes = [
    'APP', 'DB', 'MAIL', 'SMTP', 'CACHE', 'REDIS', 'AWS', 'S3',
    'LOG', 'BROADCAST', 'QUEUE', 'SESSION', 'FILESYSTEM',
    'PUSHER', 'VITE', 'MIX', 'SANCTUM', 'TELESCOPE', 'HORIZON',
    'SCOUT', 'CASHIER', 'STRIPE', 'PADDLE',
  ];
  for (const p of prefixes) {
    if (key.startsWith(p + '_') || key === p) return p;
  }
  return 'OTHER';
}

/**
 * Abre el visor visual de un archivo .env.
 *
 * Lee el contenido del archivo, lo parsea en entries agrupadas por
 * prefijo, y renderiza un panel tipo formulario con edición inline.
 * Los cambios se guardan directo al archivo .env al presionar Enter
 * o al salir del campo de edición (blur).
 *
 * @param {string} filePath - Path absoluto del archivo .env
 * @param {string} fileName - Nombre del archivo (.env, .env.local, etc.)
 */
async function openEnvViewer(filePath, fileName) {
  const envId = `__env-viewer__${filePath}`;

  // Si ya está abierto, activar
  const existing = state.openTabs.find((t) => t.path === envId);
  if (existing) {
    activateTab(existing);
    return;
  }

  const result = await window.api.readFile(filePath);
  if (result.error) {
    console.error('Error reading .env:', result.error);
    return;
  }

  const entries = parseEnvContent(result.content);
  const container = document.getElementById('env-viewer-container');

  // ── Renderizar UI ──────────────────────────────────────────
  renderEnvViewer(container, entries, filePath, fileName);

  const tab = {
    path: envId,
    name: fileName,
    model: null,
    language: 'plaintext',
    modified: false,
    envFilePath: filePath,
    envEntries: entries,
  };

  state.openTabs.push(tab);
  activateTab(tab);
}

/**
 * Renderiza el panel visual del .env con secciones colapsables.
 *
 * Cada variable se muestra como una fila KEY | VALUE con el valor
 * editable inline. Los cambios se persisten inmediatamente al .env.
 */
function renderEnvViewer(container, entries, filePath, fileName) {
  // Agrupar variables por prefijo, con APP primero y OTHER al final
  const groupMap = new Map();
  const varEntries = entries.filter((e) => e.type === 'var');
  for (const entry of varEntries) {
    const group = envGroupName(entry.key);
    if (!groupMap.has(group)) groupMap.set(group, []);
    groupMap.get(group).push(entry);
  }
  const groups = new Map();
  if (groupMap.has('APP')) { groups.set('APP', groupMap.get('APP')); groupMap.delete('APP'); }
  const other = groupMap.get('OTHER'); groupMap.delete('OTHER');
  for (const [k, v] of groupMap) groups.set(k, v);
  if (other) groups.set('OTHER', other);

  let html = `
    <div class="env-viewer-header">
      <span class="env-viewer-title">${escapeHtml(fileName)}</span>
      <span class="env-viewer-count" id="env-var-count">${varEntries.length} variables</span>
      <div class="env-search-wrap">
        <input class="env-search-input" id="env-search-input" type="text" placeholder="Filter variables..." autocomplete="off" spellcheck="false" />
      </div>
      <button class="env-viewer-collapse-btn" id="env-collapse-all" title="Collapse / Expand all groups">▾</button>
      <button class="env-viewer-raw-btn" id="env-open-raw" title="Open as plain text in editor">Open as Text</button>
    </div>
    <div class="env-viewer-body">
  `;

  for (const [groupName, vars] of groups) {
    html += `
      <div class="env-group">
        <div class="env-group-header" data-group="${escapeAttr(groupName)}">
          <span class="env-group-chevron">▾</span>
          <span class="env-group-name">${escapeHtml(groupName)}</span>
          <span class="env-group-count">${vars.length}</span>
        </div>
        <div class="env-group-rows">
    `;
    for (const v of vars) {
      html += `
          <div class="env-row">
            <span class="env-key" title="${escapeAttr(v.key)}">${escapeHtml(v.key)}</span>
            <input class="env-value" type="text" value="${escapeAttr(v.value)}" data-key="${escapeAttr(v.key)}" spellcheck="false" autocomplete="off" />
          </div>
      `;
    }
    html += `
        </div>
      </div>
    `;
  }

  html += '</div>';
  container.innerHTML = html;

  // ── "Open as Text" → abrir raw en el pane derecho (split) ──
  container.querySelector('#env-open-raw').addEventListener('click', () => {
    if (!state.split) enableSplit();
    // Pequeño delay para que el pane derecho se inicialice
    setTimeout(() => openFileInRightPane(filePath, fileName), 100);
  });

  // ── Collapse/expand de secciones ───────────────────────────
  container.querySelectorAll('.env-group-header').forEach((header) => {
    header.addEventListener('click', () => {
      const chevron = header.querySelector('.env-group-chevron');
      const rows = header.nextElementSibling;
      chevron.classList.toggle('collapsed');
      rows.classList.toggle('collapsed');
    });
  });

  // ── Collapse / Expand all ────────────────────────────────────
  const collapseBtn = container.querySelector('#env-collapse-all');
  let allCollapsed = false;
  collapseBtn.addEventListener('click', () => {
    allCollapsed = !allCollapsed;
    collapseBtn.textContent = allCollapsed ? '▸' : '▾';
    container.querySelectorAll('.env-group-chevron').forEach((c) => c.classList.toggle('collapsed', allCollapsed));
    container.querySelectorAll('.env-group-rows').forEach((r) => r.classList.toggle('collapsed', allCollapsed));
  });

  // ── Búsqueda: filtrar variables por key o value ─────────────
  const searchInput = container.querySelector('#env-search-input');
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase();
    let visible = 0;
    container.querySelectorAll('.env-row').forEach((row) => {
      const key = row.querySelector('.env-key').textContent.toLowerCase();
      const val = row.querySelector('.env-value').value.toLowerCase();
      const match = !query || key.includes(query) || val.includes(query);
      row.style.display = match ? '' : 'none';
      if (match) visible++;
    });
    // Ocultar grupos que quedaron vacíos
    container.querySelectorAll('.env-group').forEach((group) => {
      const rows = group.querySelectorAll('.env-row');
      const hasVisible = Array.from(rows).some((r) => r.style.display !== 'none');
      group.style.display = hasVisible ? '' : 'none';
      // Expandir grupos al buscar para que se vean los resultados
      if (query && hasVisible) {
        group.querySelector('.env-group-chevron')?.classList.remove('collapsed');
        group.querySelector('.env-group-rows')?.classList.remove('collapsed');
      }
    });
    // Actualizar contador
    const countEl = container.querySelector('#env-var-count');
    if (countEl) countEl.textContent = query ? `${visible} / ${varEntries.length}` : `${varEntries.length} variables`;
  });

  // ── Edición inline: guardar al salir del campo o Enter ─────
  container.querySelectorAll('.env-value').forEach((input) => {
    const save = async () => {
      const key = input.dataset.key;
      const newValue = input.value;
      const entry = entries.find((e) => e.type === 'var' && e.key === key);
      if (!entry || entry.value === newValue) return;
      entry.value = newValue;
      const content = serializeEnvContent(entries);
      await window.api.writeFile(filePath, content);
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
  });
}

function initGitPanel() {
  // Commit
  document.getElementById('git-commit-btn').addEventListener('click', gitCommit);
  document.getElementById('git-commit-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') gitCommit();
  });

  // ── Stage All / Unstage All ─────────────────────────────────
  document.getElementById('git-unstage-all-btn').addEventListener('click', async () => {
    const btn = document.getElementById('git-unstage-all-btn');
    btn.textContent = '⟳';
    btn.disabled = true;
    await window.api.gitUnstage(state.currentFolder, ['.']);
    btn.textContent = '−';
    btn.disabled = false;
    refreshGitStatus();
  });
  document.getElementById('git-stage-all-btn').addEventListener('click', async () => {
    const btn = document.getElementById('git-stage-all-btn');
    btn.textContent = '⟳';
    btn.disabled = true;
    await window.api.gitAdd(state.currentFolder, ['.']);
    btn.textContent = '+';
    btn.disabled = false;
    refreshGitStatus();
  });
  document.getElementById('git-pull-btn').addEventListener('click', gitPull);
  document.getElementById('git-push-btn').addEventListener('click', gitPush);
  document.getElementById('git-stash-btn').addEventListener('click', showStashOverlay);

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

    // Click en nombre de archivo → abrir diff, conflict view, o archivo
    const nameEl = e.target.closest('.git-file-name');
    if (nameEl) {
      const filePath = nameEl.dataset.path;
      const absPath = nameEl.dataset.abs;
      const status = nameEl.dataset.status;
      const type = nameEl.dataset.type;
      const fileName = filePath.split(/[/\\]/).pop();

      if (status === 'deleted') return;
      if (type === 'conflicted') {
        openConflictView(filePath, absPath, fileName);
      } else if (type === 'untracked') {
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

  // ── Hamburger menu (Windows/Linux) ──────────────────────────
  // En macOS el menú nativo vive en la barra del sistema.
  // En Windows/Linux no hay barra nativa con frame:false,
  // así que renderizamos un menú dropdown desde el titlebar.
  if (window.api.platform !== 'darwin') {
    initHamburgerMenu();
  }

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
  window.api.onMenuZoomIn(() => editorZoomIn());
  window.api.onMenuZoomOut(() => editorZoomOut());
  window.api.onMenuZoomReset(() => editorZoomReset());
  window.api.onMenuUiZoomIn(() => uiZoomIn());
  window.api.onMenuUiZoomOut(() => uiZoomOut());
  window.api.onMenuUiZoomReset(() => uiZoomReset());

  // Click en indicador de zoom → reset
  document.getElementById('status-zoom').addEventListener('click', () => editorZoomReset());

  // Click en la rama del status bar → abrir branch picker
  document.getElementById('status-branch').addEventListener('click', () => showBranchPicker());
  document.getElementById('status-branch').style.cursor = 'pointer';

  // Menu Git > Switch Branch
  window.api.onMenuGitCheckout(() => showBranchPicker());

  // Botones de Pull (↓) y Push (↑) en el status bar, junto al nombre de la rama.
  // Estilo VS Code: un click rápido para sincronizar sin abrir el panel de git.
  document.getElementById('status-pull').addEventListener('click', () => statusBarGitSync('pull'));
  document.getElementById('status-push').addEventListener('click', () => statusBarGitSync('push'));
  window.api.onMenuSwitchTheme((theme) => switchTheme(theme));
  // Theme generator: abrir diálogo desde Tema > Generate Theme...
  window.api.onMenuGenerateTheme(() => showThemeGenerator());

  // Eliminar un tema custom desde Tema > Delete Theme > [nombre].
  // Si el usuario elimina el tema que está activo, vuelve a Mojave Dark.
  window.api.onMenuDeleteTheme((themeId) => {
    const themes = getCustomThemes().filter(t => t.id !== themeId);
    saveCustomThemes(themes);
    if (localStorage.getItem('mojavecode-php-theme') === themeId) {
      switchTheme('dark');
    }
  });
  window.api.onAutoSaveChanged((enabled) => { state.autoSave = enabled; });

  // Track project capabilities so command palette can show/hide context-sensitive commands.
  // También actualiza el indicador de Sail en el status bar.
  window.api.onProjectCapabilities((caps) => {
    state.projectCaps = caps;
    updateDockerEnvBadge(caps);
    showDockerNoticeIfNeeded(caps);
  });

  // El usuario activó/desactivó Sail desde el menú Artisan o Composer
  window.api.onSailChanged((enabled) => {
    if (state.projectCaps) state.projectCaps.sailEnabled = enabled;
    updateDockerEnvBadge(state.projectCaps || {});
  });

  window.api.onFolderOpened((path) => loadFileTree(path));
  window.api.onFileOpened((path) => {
    const name = path.split(/[/\\]/).pop();
    openFile(path, name);
  });

  // ── File Watcher: reaccionar a cambios externos ────────────────
  //
  // Cuando un archivo abierto cambia fuera del editor (git checkout,
  // artisan, formatter externo, etc.):
  //   • Si el tab NO tiene cambios sin guardar → recargar silenciosamente
  //   • Si el tab SÍ tiene cambios → mostrar la barra de advertencia
  //
  // Se usa una cola simple: si varios archivos cambian al mismo tiempo
  // se procesan en orden; la barra muestra uno a la vez.
  const changedQueue = [];
  let fileChangedBarActive = false;

  const fileChangedBar    = document.getElementById('file-changed-bar');
  const fileChangedMsg    = document.getElementById('file-changed-msg');
  const fileChangedReload = document.getElementById('file-changed-reload');
  const fileChangedKeep   = document.getElementById('file-changed-keep');

  function processChangedQueue() {
    if (fileChangedBarActive || changedQueue.length === 0) return;
    const filePath = changedQueue.shift();

    // Buscar el tab en ambos panes
    const tab = state.openTabs.find((t) => t.path === filePath)
             || state.openTabsRight.find((t) => t.path === filePath);
    if (!tab) { processChangedQueue(); return; }

    if (!tab.modified) {
      // Sin cambios sin guardar → recargar silenciosamente
      window.api.readFile(filePath).then((result) => {
        if (result.content !== null && tab.model) {
          tab.model.setValue(result.content);
          tab.modified = false;
          renderTabs();
          renderTabsRight();
        }
        processChangedQueue();
      });
    } else {
      // Tiene cambios → mostrar barra de advertencia
      fileChangedBarActive = true;
      const name = filePath.split(/[/\\]/).pop();
      fileChangedMsg.textContent = `"${name}" changed on disk.`;
      fileChangedBar.style.display = 'flex';

      fileChangedReload.onclick = async () => {
        fileChangedBar.style.display = 'none';
        fileChangedBarActive = false;
        const result = await window.api.readFile(filePath);
        if (result.content !== null && tab.model) {
          tab.model.setValue(result.content);
          tab.modified = false;
          renderTabs();
          renderTabsRight();
        }
        processChangedQueue();
      };

      fileChangedKeep.onclick = () => {
        fileChangedBar.style.display = 'none';
        fileChangedBarActive = false;
        processChangedQueue();
      };
    }
  }

  window.api.onFileChanged((filePath) => {
    // Evitar duplicados en la cola
    if (!changedQueue.includes(filePath)) changedQueue.push(filePath);
    processChangedQueue();
  });

  // Keyboard shortcuts (complementan los del menú)
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    if (mod && e.key === '`') { e.preventDefault(); toggleTerminal(); }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); toggleQuickOpen(); }
    if (mod && !e.shiftKey && e.key === 'f' && state.activeTab?.path === '__route-list__') {
      e.preventDefault();
      const rc = document.getElementById('route-list-container');
      if (rc?._showRouteSearch) rc._showRouteSearch();
    }
    if (mod && !e.shiftKey && e.key === 'f' && state.activeTab?.path === '__db-viewer__') {
      e.preventDefault();
      const dc = document.getElementById('db-viewer-container');
      if (dc?._showDbSearch) dc._showDbSearch();
    }
    if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); showSearchPanel(); }
    if (mod && e.key === 't') { e.preventDefault(); toggleSymbolSearch(); }
    if (mod && e.key === 'w') { e.preventDefault(); if (state.activeTab) closeTab(state.activeTab.path); }
  });
}

// ┌──────────────────────────────────────────────────┐
// │  8b. THEME SWITCHER                              │
// │  Alterna entre dark, light y temas custom.       │
// │                                                  │
// │  Soporta 3 tipos de tema:                        │
// │  - 'dark'  → built-in, CSS vars en :root         │
// │  - 'light' → built-in, CSS vars en [data-theme]  │
// │  - 'custom-xxx' → generado por el usuario,       │
// │    guardado en localStorage. Las CSS vars se      │
// │    aplican como inline styles en :root (máxima    │
// │    prioridad CSS) y se registra un Monaco theme   │
// │    dinámico + tema de terminal con colores ANSI.  │
// │                                                  │
// │  Sincroniza con el menú nativo via IPC para que  │
// │  el radio button correcto esté marcado.          │
// └──────────────────────────────────────────────────┘
function switchTheme(themeName) {
  // Setear el data-theme attribute. Para temas custom esto no matchea
  // ningún selector CSS, así que las vars de :root (dark) actúan como
  // base, y luego las sobreescribimos con inline styles.
  document.documentElement.setAttribute('data-theme', themeName);

  // Buscar si es un tema custom del usuario
  const customThemes = getCustomThemes();
  const custom = customThemes.find(t => t.id === themeName);

  if (custom) {
    // ── Tema custom ──
    // 1. CSS vars → inline en :root (overridean las de [data-theme])
    applyCustomThemeVars(custom);
    // 2. Monaco → registrar y activar tema dinámico
    const monacoId = `mojavecode-custom-${custom.id}`;
    registerCustomMonacoTheme(monacoId, custom);
    monaco.editor.setTheme(monacoId);
    // 3. Terminales → actualizar los 16 colores ANSI + fondo/cursor
    const termTheme = generateTerminalTheme(custom);
    for (const info of state.terminals.values()) {
      info.xterm.options.theme = termTheme;
    }
  } else {
    // ── Tema built-in (dark/light) ──
    // Limpiar cualquier inline style que haya dejado un tema custom previo.
    // Sin esto, las vars del custom quedarían pegadas sobre el built-in.
    document.documentElement.style.cssText = '';
    const monacoTheme = themeName === 'light' ? 'mojavecode-php-light' : 'mojavecode-php-dark';
    monaco.editor.setTheme(monacoTheme);
    // Restaurar colores de terminal al tema Mojave Dark original
    if (themeName === 'dark') {
      const darkTermTheme = {
        background: '#0a1420', foreground: '#F4E2CE', cursor: '#E85324',
        cursorAccent: '#0a1420', selectionBackground: '#26476980',
        black: '#0d1a2a', red: '#EA6E40', green: '#3fb950', yellow: '#F7A73E',
        blue: '#247D9D', magenta: '#C4A882', cyan: '#2dd4bf', white: '#F4E2CE',
        brightBlack: '#6B87A8', brightRed: '#F5663C', brightGreen: '#3fb950',
        brightYellow: '#F5B25C', brightBlue: '#2dd4bf', brightMagenta: '#F1D7BA',
        brightCyan: '#2dd4bf', brightWhite: '#FEFAF7',
      };
      for (const info of state.terminals.values()) {
        info.xterm.options.theme = darkTermTheme;
      }
    }
  }

  localStorage.setItem('mojavecode-php-theme', themeName);
  window.api.syncTheme(themeName);

  // Persistir en archivo para que nuevas ventanas hereden el tema
  const allCustom = getCustomThemes();
  window.api.saveThemeConfig({ activeTheme: themeName, customThemes: allCustom });
}

async function initThemeMenu() {
  // Leer config de tema desde archivo (compartido entre ventanas/procesos).
  // Si el archivo tiene custom themes que localStorage no tiene (nueva ventana),
  // los importamos a localStorage para que el resto del código los encuentre.
  const fileConfig = await window.api.getThemeConfig();

  let customThemes = getCustomThemes();
  if (customThemes.length === 0 && fileConfig.customThemes?.length > 0) {
    // Nueva ventana: importar custom themes desde el archivo compartido
    localStorage.setItem('mojavecode-custom-themes', JSON.stringify(fileConfig.customThemes));
    customThemes = fileConfig.customThemes;
  }

  // Sincronizar temas custom con el main process para que aparezcan en el menú
  if (customThemes.length > 0) {
    window.api.syncCustomThemes(customThemes.map(t => ({ id: t.id, name: t.name })));
  }

  // Restaurar tema: preferir archivo (fuente de verdad compartida) sobre localStorage
  const saved = fileConfig.activeTheme || localStorage.getItem('mojavecode-php-theme') || 'dark';
  switchTheme(saved);

  // Hacer visible el body y notificar al main para que muestre la ventana
  document.body.classList.add('theme-ready');
  window.api.themeReady();
}

// ┌──────────────────────────────────────────────────┐
// │  8b-2. THEME GENERATOR                           │
// │  Genera temas completos a partir de 3 colores:   │
// │  fondo, acento y texto. Calcula variantes para   │
// │  CSS, Monaco Editor y xterm.js terminal.         │
// │                                                  │
// │  Los temas custom se guardan en localStorage     │
// │  y aparecen en el menú nativo Tema junto a los   │
// │  temas built-in (Dark/Light).                    │
// │                                                  │
// │  ALGORITMO DE GENERACIÓN:                        │
// │  1. Del color de fondo se derivan ~10 variantes  │
// │     (lighten/darken) para hover, active, border, │
// │     sidebar, tabs, terminal, etc.                │
// │  2. Del acento se derivan colores complementarios│
// │     (rotaciones de hue) para syntax highlighting │
// │  3. Del texto se derivan primary/secondary/muted │
// │  4. Se detecta si es dark/light por luminosidad  │
// └──────────────────────────────────────────────────┘

/** Persistencia de temas custom en localStorage */
function getCustomThemes() {
  try {
    return JSON.parse(localStorage.getItem('mojavecode-custom-themes') || '[]');
  } catch { return []; }
}

function saveCustomThemes(themes) {
  localStorage.setItem('mojavecode-custom-themes', JSON.stringify(themes));
  // Notificar al main process para reconstruir el menú Tema
  window.api.syncCustomThemes(themes.map(t => ({ id: t.id, name: t.name })));
  // Persistir en archivo para que nuevas ventanas hereden los temas
  const activeTheme = localStorage.getItem('mojavecode-php-theme') || 'dark';
  window.api.saveThemeConfig({ activeTheme, customThemes: themes });
}

// ── Utilidades de color ──
// Funciones puras para manipulación de colores usadas por el generador
// de temas. Trabajan con hex (#RRGGBB) y convierten internamente a
// RGB o HSL según la operación.
//
// Cadena de conversión: hex → RGB → HSL → manipular → HSL → RGB → hex
//
// Se usan 4 operaciones principales:
// - adjustLightness: aclarar/oscurecer (para variantes de fondo)
// - mixColors: mezclar dos colores (para text-secondary/muted)
// - rotateHue: rotar el matiz (para colores de sintaxis)
// - luminance: detectar si un fondo es dark o light

/** hex "#RRGGBB" → [R, G, B] (0-255) */
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [R, G, B] (0-255) → hex "#rrggbb" */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
}

/** [R, G, B] (0-255) → [H, S, L] (H: 0-360, S: 0-100, L: 0-100) */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h * 360, s * 100, l * 100];
}

/** [H, S, L] → hex "#rrggbb" */
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return rgbToHex(r * 255, g * 255, b * 255);
}

/**
 * Ajustar la luminosidad de un color.
 * amount positivo = aclarar, negativo = oscurecer.
 * Ejemplo: adjustLightness('#1a1a2e', 8) → un poco más claro
 */
function adjustLightness(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h, s, Math.max(0, Math.min(100, l + amount)));
}

/**
 * Mezclar dos colores con un factor de interpolación.
 * factor 0 = 100% color1, factor 1 = 100% color2.
 * Usado para generar text-secondary (25% blend) y text-muted (55% blend).
 */
function mixColors(hex1, hex2, factor) {
  const [r1, g1, b1] = hexToRgb(hex1);
  const [r2, g2, b2] = hexToRgb(hex2);
  return rgbToHex(
    r1 + (r2 - r1) * factor,
    g1 + (g2 - g1) * factor,
    b1 + (b2 - b1) * factor
  );
}

/**
 * Luminosidad percibida (fórmula ITU-R BT.601).
 * Devuelve 0-1. Si < 0.5, el color es "oscuro" y necesita texto claro.
 * Usada para decidir si un tema custom es dark o light automáticamente.
 */
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * Rotar el matiz (hue) de un color en la rueda cromática.
 * Mantiene la saturación y luminosidad originales.
 * Ejemplo: rotateHue('#e94560', 160) → color complementario para functions.
 *
 * Rotaciones usadas por el generador:
 *   +40  → numbers    +100 → strings    +130 → tags
 *   +160 → functions  +200 → blue UI    +220 → variables
 */
function rotateHue(hex, degrees) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex((h + degrees) % 360, s, l);
}

/**
 * Generar un tema completo a partir de 3 colores.
 * Devuelve un objeto con id, name, colors (los 3 inputs),
 * vars (CSS variables), isDark, y colores derivados para
 * syntax highlighting.
 */
function generateThemeFromColors(name, bgColor, accentColor, textColor) {
  const isDark = luminance(bgColor) < 0.5;
  const id = 'custom-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

  // ── Derivar variantes del fondo ──
  const bgDarkest = adjustLightness(bgColor, isDark ? -4 : 4);
  const bgDark = bgColor;
  const bgPanel = adjustLightness(bgColor, isDark ? 5 : -2);
  const bgSidebar = adjustLightness(bgColor, isDark ? -2 : 3);
  const bgHover = adjustLightness(bgColor, isDark ? 8 : -5);
  const bgActive = adjustLightness(bgColor, isDark ? 12 : -8);
  const bgTab = adjustLightness(bgColor, isDark ? 2 : 2);
  const bgTabActive = adjustLightness(bgColor, isDark ? 8 : -4);
  const bgTerminal = adjustLightness(bgColor, isDark ? -6 : 2);
  const border = adjustLightness(bgColor, isDark ? 15 : -12);

  // ── Derivar variantes del texto ──
  const textPrimary = textColor;
  const textSecondary = mixColors(textColor, bgColor, 0.25);
  const textMuted = mixColors(textColor, bgColor, 0.55);

  // ── Derivar colores de sintaxis desde el acento ──
  // Rotamos el hue del acento para generar colores complementarios
  const syntaxKeyword = accentColor;
  const syntaxFunction = rotateHue(accentColor, 160);
  const syntaxString = rotateHue(accentColor, 100);
  const syntaxNumber = rotateHue(accentColor, 40);
  const syntaxVariable = rotateHue(accentColor, 220);
  const syntaxComment = textMuted;
  const syntaxTag = rotateHue(accentColor, 130);

  // ── Colores UI derivados del acento ──
  const accentHover = adjustLightness(accentColor, 10);
  const accentRed = accentColor;
  const accentGreen = rotateHue(accentColor, 130);
  const accentBlue = rotateHue(accentColor, 200);
  const accentYellow = rotateHue(accentColor, 50);
  const accentTeal = rotateHue(accentColor, 170);

  return {
    id, name, isDark,
    colors: { bg: bgColor, accent: accentColor, text: textColor },
    vars: {
      '--bg-darkest': bgDarkest, '--bg-dark': bgDark, '--bg-panel': bgPanel,
      '--bg-sidebar': bgSidebar, '--bg-hover': bgHover, '--bg-active': bgActive,
      '--bg-tab': bgTab, '--bg-tab-active': bgTabActive, '--bg-terminal': bgTerminal,
      '--border': border,
      '--text-primary': textPrimary, '--text-secondary': textSecondary, '--text-muted': textMuted,
      '--accent': accentColor, '--accent-hover': accentHover,
      '--accent-blue': accentBlue, '--accent-teal': accentTeal,
      '--accent-yellow': accentYellow, '--accent-red': accentRed,
      '--accent-green': accentGreen,
    },
    syntax: {
      keyword: syntaxKeyword, function: syntaxFunction, string: syntaxString,
      number: syntaxNumber, variable: syntaxVariable, comment: syntaxComment,
      tag: syntaxTag, type: accentHover, constant: syntaxNumber,
    },
  };
}

/** Aplicar las CSS variables de un tema custom al :root */
function applyCustomThemeVars(theme) {
  const root = document.documentElement;
  for (const [prop, value] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, value);
  }
}

/** Registrar un tema custom en Monaco Editor */
function registerCustomMonacoTheme(monacoId, theme) {
  const syn = theme.syntax;
  const strip = (hex) => hex.replace('#', '');

  monaco.editor.defineTheme(monacoId, {
    base: theme.isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      // ── Base token (catch-all para tokens no definidos) ──
      { token: '', foreground: strip(theme.vars['--text-primary']) },
      // ── Core syntax ──
      { token: 'comment', foreground: strip(syn.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: strip(syn.keyword), fontStyle: 'bold' },
      { token: 'keyword.control', foreground: strip(syn.keyword), fontStyle: 'bold' },
      { token: 'string', foreground: strip(syn.string) },
      { token: 'string.escape', foreground: strip(syn.number) },
      { token: 'number', foreground: strip(syn.number) },
      { token: 'number.float', foreground: strip(syn.number) },
      { token: 'type', foreground: strip(syn.type) },
      { token: 'type.identifier', foreground: strip(syn.type) },
      { token: 'function', foreground: strip(syn.function) },
      { token: 'variable', foreground: strip(syn.variable) },
      { token: 'variable.predefined', foreground: strip(syn.variable) },
      { token: 'constant', foreground: strip(syn.constant), fontStyle: 'bold' },
      // ── HTML / Blade ──
      { token: 'tag', foreground: strip(syn.tag) },
      { token: 'tag.id.pug', foreground: strip(syn.tag) },
      { token: 'tag.class.pug', foreground: strip(syn.tag) },
      { token: 'attribute.name', foreground: strip(theme.vars['--accent-blue']) },
      { token: 'attribute.value', foreground: strip(syn.string) },
      { token: 'metatag', foreground: strip(syn.keyword) },
      { token: 'metatag.content', foreground: strip(syn.string) },
      // ── Delimiters & operators ──
      { token: 'delimiter', foreground: strip(theme.vars['--text-secondary']) },
      { token: 'delimiter.bracket', foreground: strip(theme.vars['--text-secondary']) },
      { token: 'operator', foreground: strip(theme.vars['--text-primary']) },
      // ── PHP specific ──
      { token: 'metatag.php', foreground: strip(syn.keyword) },
      { token: 'identifier', foreground: strip(theme.vars['--text-primary']) },
      { token: 'namespace', foreground: strip(syn.type) },
    ],
    colors: {
      // ── Editor surface ──
      'editor.background': theme.vars['--bg-panel'],
      'editor.foreground': theme.vars['--text-primary'],
      'editor.lineHighlightBackground': theme.vars['--bg-hover'],
      'editor.selectionBackground': theme.vars['--bg-active'],
      'editor.inactiveSelectionBackground': theme.vars['--bg-active'],
      'editorCursor.foreground': theme.vars['--accent'],
      'editorLineNumber.foreground': theme.vars['--text-muted'],
      'editorLineNumber.activeForeground': theme.vars['--text-primary'],
      'editorIndentGuide.background': theme.vars['--border'],
      'editorIndentGuide.activeBackground': adjustLightness(theme.vars['--border'], 5),
      'editorBracketMatch.border': theme.vars['--accent'],
      'editorBracketMatch.background': theme.vars['--accent'] + '20',
      'minimap.background': theme.vars['--bg-dark'],
      'scrollbarSlider.background': theme.vars['--border'] + '80',
      'scrollbarSlider.hoverBackground': theme.vars['--text-muted'] + '60',
      // ── Widgets & overlays (evita herencia del azul de vs-dark/vs) ──
      'editorWidget.background': theme.vars['--bg-sidebar'],
      'editorWidget.foreground': theme.vars['--text-primary'],
      'editorWidget.border': theme.vars['--border'],
      'editorSuggestWidget.background': theme.vars['--bg-sidebar'],
      'editorSuggestWidget.border': theme.vars['--border'],
      'editorSuggestWidget.foreground': theme.vars['--text-primary'],
      'editorSuggestWidget.selectedBackground': theme.vars['--bg-active'],
      'editorSuggestWidget.highlightForeground': theme.vars['--accent'],
      'editorHoverWidget.background': theme.vars['--bg-sidebar'],
      'editorHoverWidget.border': theme.vars['--border'],
      'editorHoverWidget.foreground': theme.vars['--text-primary'],
      // ── Peek view / references ──
      'peekView.border': theme.vars['--accent'],
      'peekViewEditor.background': theme.vars['--bg-dark'],
      'peekViewResult.background': theme.vars['--bg-sidebar'],
      'peekViewResult.selectionBackground': theme.vars['--bg-active'],
      'peekViewTitle.background': theme.vars['--bg-sidebar'],
      'peekViewTitleLabel.foreground': theme.vars['--text-primary'],
      'peekViewTitleDescription.foreground': theme.vars['--text-muted'],
      // ── Find / replace widget ──
      'editorFindMatch.background': theme.vars['--accent'] + '40',
      'editor.findMatchHighlightBackground': theme.vars['--accent'] + '25',
      'editor.findRangeHighlightBackground': theme.vars['--bg-active'] + '40',
      // ── Gutter & decorations ──
      'editorGutter.background': theme.vars['--bg-panel'],
      'editorGutter.modifiedBackground': theme.vars['--accent-blue'],
      'editorGutter.addedBackground': theme.vars['--accent-green'],
      'editorGutter.deletedBackground': theme.vars['--accent-red'],
      // ── Errors / warnings ──
      'editorError.foreground': theme.vars['--accent-red'],
      'editorWarning.foreground': theme.vars['--accent-yellow'],
      'editorInfo.foreground': theme.vars['--accent-blue'],
      // ── Overview ruler (minimap sidebar) ──
      'editorOverviewRuler.border': theme.vars['--border'],
      'editorOverviewRuler.errorForeground': theme.vars['--accent-red'],
      'editorOverviewRuler.warningForeground': theme.vars['--accent-yellow'],
    },
  });
}

/** Generar tema de terminal (colores ANSI) para un tema custom */
function generateTerminalTheme(theme) {
  return {
    background: theme.vars['--bg-terminal'],
    foreground: theme.vars['--text-primary'],
    cursor: theme.vars['--accent'],
    cursorAccent: theme.vars['--bg-terminal'],
    selectionBackground: theme.vars['--bg-active'] + '80',
    black: theme.vars['--bg-darkest'],
    red: theme.vars['--accent-red'],
    green: theme.vars['--accent-green'],
    yellow: theme.vars['--accent-yellow'],
    blue: theme.vars['--accent-blue'],
    magenta: theme.syntax.variable,
    cyan: theme.vars['--accent-teal'],
    white: theme.vars['--text-primary'],
    brightBlack: theme.vars['--text-muted'],
    brightRed: adjustLightness(theme.vars['--accent-red'], 10),
    brightGreen: adjustLightness(theme.vars['--accent-green'], 10),
    brightYellow: adjustLightness(theme.vars['--accent-yellow'], 10),
    brightBlue: adjustLightness(theme.vars['--accent-blue'], 10),
    brightMagenta: adjustLightness(theme.syntax.variable, 10),
    brightCyan: adjustLightness(theme.vars['--accent-teal'], 10),
    brightWhite: adjustLightness(theme.vars['--text-primary'], 10),
  };
}

// ── UI del Theme Generator ──
// El diálogo tiene un mini-preview que se actualiza en tiempo real
// cada vez que el usuario mueve un color picker. Esto le permite
// ver cómo quedarán el sidebar, el editor (con syntax highlighting
// de ejemplo) y la barra de estado antes de crear el tema.

function showThemeGenerator() {
  const overlay = document.getElementById('theme-gen-overlay');
  overlay.style.display = 'flex';
  document.getElementById('theme-gen-name').value = '';
  document.getElementById('theme-gen-name').focus();
  updateThemePreview();
}

function closeThemeGenerator() {
  document.getElementById('theme-gen-overlay').style.display = 'none';
}

/**
 * Actualizar el mini-preview en vivo.
 * Se ejecuta en cada evento 'input' de los 3 color pickers.
 * Calcula las mismas derivaciones que generateThemeFromColors
 * pero solo aplica las que son visibles en el preview.
 */
function updateThemePreview() {
  const bg = document.getElementById('theme-gen-bg').value;
  const accent = document.getElementById('theme-gen-accent').value;
  const text = document.getElementById('theme-gen-text').value;

  // Actualizar los labels hex
  document.querySelectorAll('.theme-gen-hex').forEach(span => {
    const input = document.getElementById(span.dataset.for);
    if (input) span.textContent = input.value;
  });

  const preview = document.getElementById('theme-gen-preview');
  const isDark = luminance(bg) < 0.5;
  const sidebar = adjustLightness(bg, isDark ? -2 : 3);
  const panel = adjustLightness(bg, isDark ? 5 : -2);
  const bar = adjustLightness(bg, isDark ? -4 : 4);
  const muted = mixColors(text, bg, 0.55);
  const fnColor = rotateHue(accent, 160);
  const strColor = rotateHue(accent, 100);

  preview.querySelector('.theme-preview-bar').style.background = bar;
  preview.querySelector('.theme-preview-body').style.background = panel;
  preview.querySelector('.theme-preview-sidebar').style.background = sidebar;
  preview.querySelector('.theme-preview-sidebar').style.borderRight = `1px solid ${adjustLightness(bg, isDark ? 15 : -12)}`;
  preview.querySelector('.theme-preview-editor').style.color = text;
  preview.querySelector('.theme-preview-statusbar').style.background = bar;
  preview.querySelectorAll('.tp-keyword').forEach(el => el.style.color = accent);
  preview.querySelectorAll('.tp-function').forEach(el => el.style.color = fnColor);
  preview.querySelectorAll('.tp-string').forEach(el => el.style.color = strColor);
}

/** Inicializar los event listeners del diálogo del theme generator */
(function initThemeGenerator() {
  const overlay = document.getElementById('theme-gen-overlay');
  if (!overlay) return;

  // Live preview cuando cambian los color pickers
  ['theme-gen-bg', 'theme-gen-accent', 'theme-gen-text'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateThemePreview);
  });

  // Cerrar con overlay o botón cancel
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeThemeGenerator();
  });
  document.getElementById('theme-gen-cancel').addEventListener('click', closeThemeGenerator);

  // Escape para cerrar
  document.getElementById('theme-gen-name').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeThemeGenerator();
  });

  // Crear tema
  document.getElementById('theme-gen-apply').addEventListener('click', () => {
    const name = document.getElementById('theme-gen-name').value.trim();
    if (!name) {
      document.getElementById('theme-gen-name').focus();
      return;
    }

    const bg = document.getElementById('theme-gen-bg').value;
    const accent = document.getElementById('theme-gen-accent').value;
    const text = document.getElementById('theme-gen-text').value;

    const theme = generateThemeFromColors(name, bg, accent, text);

    // Guardar en la lista de temas custom
    const themes = getCustomThemes();
    // Si ya existe uno con el mismo id, reemplazarlo
    const existIdx = themes.findIndex(t => t.id === theme.id);
    if (existIdx !== -1) {
      themes[existIdx] = theme;
    } else {
      themes.push(theme);
    }
    saveCustomThemes(themes);

    // Aplicar el nuevo tema
    switchTheme(theme.id);

    closeThemeGenerator();
  });
})();

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

/**
 * Convierte códigos de escape ANSI SGR a spans HTML con estilos inline.
 * Soporta colores de 16 colores (30–37, 39, 90–97 para fg; 40–47, 49, 100–107 para bg),
 * negrita (1/22) y reset (0). Secuencias no-color (cursor, borrar línea, etc.) son
 * eliminadas silenciosamente para que no aparezcan como texto basura.
 *
 * @param {string} raw - Texto con códigos ANSI
 * @returns {string} HTML seguro para insertar en innerHTML
 */
function ansiToHtml(raw) {
  // Colores de 16 — paleta tipo One Dark para que quede bien en ambos temas
  const FG = {
    30: '#666',    31: '#e06c75', 32: '#98c379', 33: '#e5c07b',
    34: '#61afef', 35: '#c678dd', 36: '#56b6c2', 37: '#ddd',
    90: '#888',    91: '#ff7675', 92: '#a3e08c', 93: '#ffeaa7',
    94: '#74b9ff', 95: '#fd79a8', 96: '#81ecec', 97: '#fff',
  };
  const BG = {
    40: '#2c2c2c', 41: '#8b0000', 42: '#1e5c2e', 43: '#7d6608',
    44: '#1a5276', 45: '#7d3c98', 46: '#0e6655', 47: '#999',
    100: '#555',   101: '#c0392b', 102: '#27ae60', 103: '#d4ac0d',
    104: '#2980b9', 105: '#8e44ad', 106: '#148f77', 107: '#eee',
  };

  // Eliminar secuencias ANSI no-color antes de procesar
  // (movimiento de cursor, borrar pantalla, OSC, etc.)
  const cleaned = raw.replace(/\x1b\[[0-9;]*[A-HJKSTf]/g, '')
                     .replace(/\x1b\][^\x07]*\x07/g, '')
                     .replace(/\x1b[()][AB012]/g, '');

  // Dividir en [texto, códigos, texto, códigos, ...]
  const parts = cleaned.split(/\x1b\[([0-9;]*)m/);
  let html = '';
  let openSpans = 0;

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Texto plano — escapar HTML
      html += parts[i]
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    } else {
      // Cerrar todos los spans abiertos antes de abrir nuevos
      html += '</span>'.repeat(openSpans);
      openSpans = 0;

      // Código vacío o 0 = reset, ya cerramos todo arriba
      if (!parts[i] || parts[i] === '0') continue;

      const codes = parts[i].split(';').map(Number);
      let fg = null, bg = null, bold = false;

      for (const c of codes) {
        if (c === 1)  { bold = true; }
        else if (c === 22) { bold = false; }
        else if (FG[c] !== undefined) { fg = FG[c]; }
        else if (BG[c] !== undefined) { bg = BG[c]; }
        // 39/49 = default fg/bg — ya se resetea al cerrar el span
      }

      let style = '';
      if (fg) style += `color:${fg};`;
      if (bg) style += `background:${bg};padding:1px 5px;border-radius:3px;`;
      if (bold) style += 'font-weight:700;';

      if (style) {
        html += `<span style="${style}">`;
        openSpans++;
      }
    }
  }

  html += '</span>'.repeat(openSpans);
  return html;
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
// │  9a3. COMMAND PALETTE (Cmd+Shift+P)              │
// │  Paleta de comandos al estilo VS Code. Muestra   │
// │  todos los comandos disponibles con shortcuts,   │
// │  filtrables por texto. Algunos comandos están    │
// │  condicionados a las capacidades del proyecto    │
// │  (hasArtisan, hasPhpUnit, etc.).                 │
// └──────────────────────────────────────────────────┘

/**
 * Estado interno de la paleta de comandos.
 * filtered: lista de items visibles después de filtrar (incluye separadores de categoría).
 * commands: solo los comandos reales (sin separadores).
 * selectedIndex: índice dentro de `filteredCommands` (solo comandos, no headers).
 */
const commandPalette = {
  visible: false,
  allCommands: [],     // Registro completo
  filteredCommands: [], // Comandos que pasan el filtro actual
  selectedIndex: 0,
};

/**
 * Construye y devuelve la lista completa de comandos disponibles.
 * Cada comando: { id, label, category, shortcut?, action }
 * condition() — si devuelve false, el comando no se muestra.
 */
function buildCommandRegistry() {
  return [
    // ── File ───────────────────────────────────────────────────
    {
      id: 'file.openFolder',
      label: 'Open Folder...',
      category: 'File',
      shortcut: '⌘O',
      action: () => window.api.openFolder(),
    },
    {
      id: 'file.newWindow',
      label: 'New Window',
      category: 'File',
      shortcut: '⌘⇧N',
      action: () => window.api.windowNew(),
    },
    {
      id: 'file.save',
      label: 'Save File',
      category: 'File',
      shortcut: '⌘S',
      action: () => saveCurrentFile(),
    },
    {
      id: 'file.saveAs',
      label: 'Save As...',
      category: 'File',
      shortcut: '⌘⇧S',
      action: async () => {
        const tab = state.activePaneRight ? state.activeTabRight : state.activeTab;
        if (!tab || !tab.model) return;
        const newPath = await window.api.saveAs(tab.path);
        if (newPath) {
          await window.api.writeFile(newPath, tab.model.getValue());
        }
      },
    },
    {
      id: 'file.closeTab',
      label: 'Close Tab',
      category: 'File',
      shortcut: '⌘W',
      action: () => {
        const tab = state.activePaneRight ? state.activeTabRight : state.activeTab;
        if (tab) closeTab(tab.path);
      },
    },

    // ── View ───────────────────────────────────────────────────
    {
      id: 'view.toggleSidebar',
      label: 'Toggle Sidebar',
      category: 'View',
      shortcut: '⌘B',
      action: () => toggleSidebar(),
    },
    {
      id: 'view.toggleTerminal',
      label: 'Toggle Terminal',
      category: 'View',
      shortcut: '⌃`',
      action: () => toggleTerminal(),
    },
    {
      id: 'view.newTerminal',
      label: 'New Terminal',
      category: 'View',
      action: () => {
        const existing = state.openTabs.find((t) => t.path === '__terminal__');
        if (!existing) toggleTerminal();
        else activateTab(existing);
        createTerminalInstance();
      },
    },
    {
      id: 'view.splitEditor',
      label: 'Split Editor',
      category: 'View',
      shortcut: '⌘\\',
      action: () => {
        if (state.split) disableSplit(); else enableSplit();
      },
    },
    {
      id: 'view.toggleGit',
      label: 'Toggle Git Panel',
      category: 'View',
      action: () => toggleGitPanel(),
    },
    {
      id: 'view.toggleSearch',
      label: 'Toggle Search Panel',
      category: 'View',
      action: () => toggleSearchPanel(),
    },
    {
      id: 'view.zoomIn',
      label: 'Zoom In',
      category: 'View',
      shortcut: '⌘+',
      action: () => editorZoomIn(),
    },
    {
      id: 'view.zoomOut',
      label: 'Zoom Out',
      category: 'View',
      shortcut: '⌘-',
      action: () => editorZoomOut(),
    },
    {
      id: 'view.zoomReset',
      label: 'Reset Zoom',
      category: 'View',
      action: () => editorZoomReset(),
    },

    // ── Go ─────────────────────────────────────────────────────
    {
      id: 'go.file',
      label: 'Go to File...',
      category: 'Go',
      shortcut: '⌘P',
      action: () => toggleQuickOpen(),
    },
    {
      id: 'go.symbol',
      label: 'Go to Symbol...',
      category: 'Go',
      shortcut: '⌘T',
      action: () => toggleSymbolSearch(),
    },

    // ── Git ────────────────────────────────────────────────────
    {
      id: 'git.switchBranch',
      label: 'Switch Branch...',
      category: 'Git',
      shortcut: '⌘⇧B',
      action: () => showBranchPicker(),
    },
    {
      id: 'git.pull',
      label: 'Git Pull',
      category: 'Git',
      action: () => gitPull(),
    },
    {
      id: 'git.push',
      label: 'Git Push',
      category: 'Git',
      action: () => gitPush(),
    },
    {
      id: 'git.stash',
      label: 'Git Stash...',
      category: 'Git',
      action: () => showStashOverlay(),
    },

    // ── Refactor ───────────────────────────────────────────────
    {
      id: 'refactor.rename',
      label: 'Rename Symbol (F2)',
      category: 'Refactor',
      action: () => { if (state.editor) state.editor.getAction('editor.action.rename')?.run(); },
    },

    // ── Theme ──────────────────────────────────────────────────
    {
      id: 'theme.dark',
      label: 'Switch to Dark Theme',
      category: 'Theme',
      action: () => switchTheme('dark'),
    },
    {
      id: 'theme.light',
      label: 'Switch to Light Theme',
      category: 'Theme',
      action: () => switchTheme('light'),
    },
    {
      id: 'theme.generate',
      label: 'Generate Theme...',
      category: 'Theme',
      action: () => showThemeGenerator(),
    },

    // ── PHP / Laravel ──────────────────────────────────────────
    {
      id: 'php.formatFile',
      label: 'Format File (Pint / PHP CS Fixer)',
      category: 'PHP',
      condition: () => state.projectCaps && state.projectCaps.hasPint,
      action: async () => {
        if (!state.activeTab || !state.activeTab.path) return;
        await window.api.phpFormat(state.activeTab.path);
      },
    },
    {
      id: 'php.phpunitAll',
      label: 'Run All Tests (PHPUnit)',
      category: 'PHP',
      condition: () => state.projectCaps && state.projectCaps.hasPhpUnit,
      action: async () => {
        showCommandOutput('Running: PHPUnit (all tests)', 'Executing...', null, 0);
        const result = await window.api.phpunitRun([]);
        showCommandOutput('$ vendor/bin/phpunit', result.output || '', result.error || '', result.code);
      },
    },
    {
      id: 'php.phpunitFile',
      label: 'Run Tests in Current File (PHPUnit)',
      category: 'PHP',
      condition: () => state.projectCaps && state.projectCaps.hasPhpUnit,
      action: async () => {
        if (!state.activeTab || !state.activeTab.path || state.activeTab.path.startsWith('__')) {
          alert('No PHP file is open');
          return;
        }
        const filePath = state.activeTab.path;
        const fileName = filePath.split(/[/\\]/).pop();
        showCommandOutput(`Running: PHPUnit (${fileName})`, 'Executing...', null, 0);
        const result = await window.api.phpunitRun([filePath]);
        showCommandOutput(`$ vendor/bin/phpunit ${fileName}`, result.output || '', result.error || '', result.code);
      },
    },
    {
      id: 'laravel.dbViewer',
      label: 'Open DB Viewer',
      category: 'Laravel',
      condition: () => state.projectCaps && state.projectCaps.hasArtisan,
      action: () => openDbViewer(),
    },
    {
      id: 'laravel.routeList',
      label: 'Open Route List',
      category: 'Laravel',
      condition: () => state.projectCaps && state.projectCaps.hasArtisan,
      action: () => openRouteList(),
    },
  ];
}

/**
 * Fuzzy-ish filter: devuelve true si todas las palabras del query
 * aparecen en el label o categoría del comando (case-insensitive).
 */
function commandMatchesQuery(cmd, query) {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const haystack = (cmd.category + ' ' + cmd.label).toLowerCase();
  return q.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * Resalta las letras del query dentro del label del comando.
 * Usa el mismo estilo mark que el quick-open (color acento, sin background).
 */
function highlightCommandLabel(label, query) {
  if (!query.trim()) return escapeHtml(label);
  const escaped = escapeHtml(label);
  const words = query.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return escaped;
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return escaped.replace(re, '<mark>$1</mark>');
}

/**
 * Dibuja la lista de resultados en el panel de la paleta.
 * Agrupa por categoría e inserta separadores visuales.
 */
function renderCommandResults(query) {
  const list = document.getElementById('command-palette-results');
  if (!list) return;

  // Filtrar y mantener orden del registro
  const commands = commandPalette.allCommands.filter((cmd) => {
    if (typeof cmd.condition === 'function' && !cmd.condition()) return false;
    return commandMatchesQuery(cmd, query);
  });

  commandPalette.filteredCommands = commands;

  if (!commands.length) {
    list.innerHTML = '<div class="cp-empty">No commands match your search</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  let lastCategory = null;

  commands.forEach((cmd, idx) => {
    // Insertar separador de categoría cuando cambia
    if (cmd.category !== lastCategory) {
      const header = document.createElement('div');
      header.className = 'cp-category';
      header.textContent = cmd.category;
      fragment.appendChild(header);
      lastCategory = cmd.category;
    }

    const item = document.createElement('div');
    item.className = 'cp-item' + (idx === commandPalette.selectedIndex ? ' selected' : '');
    item.dataset.index = idx;

    const labelEl = document.createElement('span');
    labelEl.className = 'cp-label';
    labelEl.innerHTML = highlightCommandLabel(cmd.label, query);

    item.appendChild(labelEl);

    if (cmd.shortcut) {
      const kbd = document.createElement('span');
      kbd.className = 'cp-shortcut';
      kbd.textContent = cmd.shortcut;
      item.appendChild(kbd);
    }

    item.addEventListener('click', () => {
      closeCommandPalette();
      cmd.action();
    });

    fragment.appendChild(item);
  });

  list.innerHTML = '';
  list.appendChild(fragment);
}

/**
 * Sincroniza la clase CSS `selected` con el índice actual.
 * También hace scroll para mantener el ítem seleccionado visible.
 */
function updateCommandPaletteSelection() {
  const items = document.querySelectorAll('#command-palette-results .cp-item');
  items.forEach((el, i) => {
    el.classList.toggle('selected', i === commandPalette.selectedIndex);
  });
  // Scroll into view
  if (items[commandPalette.selectedIndex]) {
    items[commandPalette.selectedIndex].scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Abre la paleta de comandos: reconstruye el registro (para reflejar
 * el estado actual de projectCaps), limpia el input, renderiza la
 * lista completa y mueve el foco al input.
 */
function openCommandPalette() {
  commandPalette.allCommands = buildCommandRegistry();
  commandPalette.selectedIndex = 0;
  commandPalette.visible = true;

  const overlay = document.getElementById('command-palette-overlay');
  const input = document.getElementById('command-palette-input');
  overlay.style.display = 'flex';
  input.value = '';
  renderCommandResults('');
  input.focus();
}

/**
 * Cierra la paleta de comandos y oculta el overlay.
 */
function closeCommandPalette() {
  commandPalette.visible = false;
  const overlay = document.getElementById('command-palette-overlay');
  overlay.style.display = 'none';
}

/**
 * Alterna la visibilidad de la paleta de comandos.
 * Llamado por Cmd+Shift+P tanto desde el document listener como
 * desde el addCommand de Monaco.
 */
function toggleCommandPalette() {
  if (commandPalette.visible) {
    closeCommandPalette();
  } else {
    openCommandPalette();
  }
}

/**
 * Inicializa la paleta de comandos: registra los listeners del input
 * (filtro en tiempo real, navegación con flechas, Enter/Escape),
 * el cierre al hacer click fuera, y el shortcut global Cmd+Shift+P.
 * Se llama una sola vez desde init().
 */
function initCommandPalette() {
  const input = document.getElementById('command-palette-input');
  const overlay = document.getElementById('command-palette-overlay');

  input.addEventListener('input', () => {
    commandPalette.selectedIndex = 0;
    renderCommandResults(input.value);
  });

  input.addEventListener('keydown', (e) => {
    const total = commandPalette.filteredCommands.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCommandPalette();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (commandPalette.selectedIndex < total - 1) {
        commandPalette.selectedIndex++;
        updateCommandPaletteSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandPalette.selectedIndex > 0) {
        commandPalette.selectedIndex--;
        updateCommandPaletteSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = commandPalette.filteredCommands[commandPalette.selectedIndex];
      if (cmd) {
        closeCommandPalette();
        cmd.action();
      }
    }
  });

  // Click outside the palette box closes it
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeCommandPalette();
  });

  // Global Cmd+Shift+P shortcut
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      toggleCommandPalette();
    }
  });
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
    <div class="cmd-output-body ${isError ? 'cmd-output-error' : 'cmd-output-success'}">${ansiToHtml(bodyText || 'Done (no output)')}</div>
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

  // ── New Laravel Project ──
  // Flujo completo para crear un proyecto Laravel desde cero:
  // 1. Prompt → nombre del proyecto (ej: "my-app")
  // 2. Diálogo nativo → elegir carpeta destino (ej: ~/projects)
  // 3. Ejecutar composer create-project en background
  // 4. Al terminar, abrir el proyecto automáticamente
  //
  // El output se muestra en el tab Output en tiempo real para que
  // el usuario pueda ver el progreso de la descarga de paquetes.
  window.api.onComposerNewLaravel(async () => {
    const projectName = await showCommandPrompt(
      'New Laravel Project',
      'my-app',
      'Project folder name (e.g. my-app, blog, api)'
    );
    if (!projectName) return;

    // Validar que el nombre sea seguro para usar como nombre de carpeta.
    // Evitar caracteres especiales que puedan causar problemas en el filesystem
    // o en los comandos de Composer.
    if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
      showCommandOutput(
        'New Laravel Project',
        '',
        'Invalid project name. Use only letters, numbers, hyphens and underscores.',
        1
      );
      return;
    }

    // Abrir diálogo nativo para elegir dónde crear el proyecto
    const folderResult = await window.api.chooseFolder();
    if (folderResult.canceled) return;

    // Mostrar estado de "en progreso" mientras Composer trabaja.
    // Esto puede tardar varios minutos en conexiones lentas.
    showCommandOutput(
      `Creating: composer create-project laravel/laravel ${projectName}`,
      `Installing in ${folderResult.path}/${projectName}...\nThis may take a few minutes.`,
      null,
      0
    );

    const result = await window.api.composerCreateProject(folderResult.path, projectName);

    // Mostrar el resultado final (éxito o error)
    showCommandOutput(
      `$ composer create-project laravel/laravel ${projectName}`,
      result.output || '',
      result.error || '',
      result.code
    );
  });

  // ── Tinker ──
  window.api.onArtisanTinker(async () => {
    // Abrir terminal y ejecutar tinker ahí
    const existing = state.openTabs.find((t) => t.path === '__terminal__');
    if (!existing) {
      toggleTerminal();
    } else {
      activateTab(existing);
    }
    // Esperar a que la terminal se cree si es nueva
    const waitForTerminal = () => new Promise((resolve) => {
      const check = () => state.activeTerminalId && state.terminals.has(state.activeTerminalId) ? resolve() : setTimeout(check, 50);
      check();
    });
    await waitForTerminal();
    const active = state.terminals.get(state.activeTerminalId);
    if (active?.ptyId) {
      setTimeout(() => window.api.ptyWrite(active.ptyId, 'php artisan tinker\n'), 200);
    }
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

  // Intentar obtener múltiples conexiones
  const connResult = await window.api.dbGetConnections();
  let connections;

  if (connResult.error) {
    // Fallback a la config simple
    const config = await window.api.dbGetConfig();
    if (config.error) {
      container.innerHTML = `
        <div class="db-error">Database config error</div>
        <pre class="route-raw-output">${escapeHtml(config.error)}</pre>`;
      console.error('[DB Viewer]', config.error);
      return;
    }
    connections = [{ key: 'default', label: config.database, config }];
  } else {
    connections = connResult.connections;
  }

  if (!connections || connections.length === 0) {
    container.innerHTML = '<div class="db-error">No database configured in .env</div>';
    return;
  }

  const multiDb = connections.length > 1;

  // Header global con search + botón export dump
  const firstConnKey = connections[0]?.key || '';
  let html = `
    <div class="db-header">
      <span class="db-header-title">${multiDb ? `${connections.length} Databases` : escapeHtml(connections[0].config.database)}</span>
      ${!multiDb ? `<span class="db-header-host">${escapeHtml(connections[0].config.connection)}://${escapeHtml(connections[0].config.host)}:${connections[0].config.port}</span>` : ''}
      <span class="db-header-count"></span>
      <button class="db-btn-console" id="db-btn-console" title="SQL Console">SQL</button>
      <div class="db-search-bar" id="db-search-bar" style="display:none">
        <input id="db-search-input" type="text" placeholder="Filter tables..." autocomplete="off" spellcheck="false" />
        <span id="db-search-count" class="route-search-count"></span>
        <button id="db-search-close" class="route-search-close" title="Close (Esc)">&times;</button>
      </div>
    </div>
    <div class="db-console" id="db-console" style="display:none">
      <div class="db-console-header">
        <span class="db-console-title">SQL Console</span>
        <select class="db-console-conn" id="db-console-conn">
          ${connections.map((c) => `<option value="${escapeAttr(c.key)}">${escapeHtml(c.config.database)}</option>`).join('')}
        </select>
        <button class="db-console-run" id="db-console-run" title="Run (Cmd+Enter)">▶ Run</button>
        <button class="db-console-clear" id="db-console-clear" title="Clear results">Clear</button>
      </div>
      <textarea class="db-console-input" id="db-console-input" placeholder="SELECT * FROM users LIMIT 10;" spellcheck="false" rows="4"></textarea>
      <div class="db-console-results" id="db-console-results"></div>
    </div>`;

  // Cargar tablas de cada conexión en paralelo
  const tablesResults = await Promise.all(
    connections.map((conn) => window.api.dbGetTables(conn.key))
  );

  let totalTables = 0;

  for (let i = 0; i < connections.length; i++) {
    const conn = connections[i];
    const result = tablesResults[i];

    if (multiDb) {
      // Sección colapsable por base de datos
      html += `
        <div class="db-connection-group" data-conn-key="${escapeAttr(conn.key)}">
          <div class="db-connection-header">
            <span class="db-connection-chevron">▸</span>
            <span class="db-connection-icon">DB</span>
            <span class="db-connection-name">${escapeHtml(conn.config.database)}</span>
            <span class="db-connection-info">${escapeHtml(conn.config.connection)}://${escapeHtml(conn.config.host)}:${conn.config.port}</span>
            <span class="db-connection-count">${result.error ? 'error' : `${result.tables.length} tables`}</span>
          </div>
          <div class="db-connection-body" style="display:none">`;
    }

    if (result.error) {
      html += `
        <div class="db-error">Connection failed</div>
        <pre class="route-raw-output">${escapeHtml(result.error)}</pre>`;
    } else {
      totalTables += result.tables.length;
      html += '<div class="db-table-list">';
      for (const table of result.tables) {
        html += `
          <div class="db-table-group" data-table="${escapeAttr(table)}" data-conn-key="${escapeAttr(conn.key)}">
            <div class="db-table-header">
              <span class="db-table-chevron">▸</span>
              <span class="db-table-icon">T</span>
              <span class="db-table-name">${escapeHtml(table)}</span>
            </div>
            <div class="db-table-columns" style="display:none"></div>
          </div>`;
      }
      html += '</div>';
    }

    if (multiDb) {
      html += '</div></div>';
    }
  }

  container.innerHTML = html;

  // Actualizar conteo total + botón Export DB al lado
  const headerCount = container.querySelector('.db-header-count');
  if (headerCount) {
    headerCount.innerHTML = `${totalTables} tables <button class="db-btn-dump" id="db-btn-dump" title="Export full database dump">Export DB</button>`;
  }

  // ── SQL Console ────────────────────────────────────────────────
  initDbConsole(container, connections);

  // ── Export DB dump ─────────────────────────────────────────────
  const dumpBtn = container.querySelector('#db-btn-dump');
  if (dumpBtn) {
    dumpBtn.addEventListener('click', () => dbExportDump(null, connections));
  }

  // Click handlers para secciones de conexión (collapse/expand)
  if (multiDb) {
    container.querySelectorAll('.db-connection-header').forEach((header) => {
      header.addEventListener('click', () => {
        const group = header.closest('.db-connection-group');
        const body = group.querySelector('.db-connection-body');
        const chevron = group.querySelector('.db-connection-chevron');
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : '';
        chevron.textContent = isOpen ? '▸' : '▾';
      });
    });
  }

  // Click handlers: expand/collapse tables
  container.querySelectorAll('.db-table-header').forEach((header) => {
    header.addEventListener('click', async () => {
      const group = header.closest('.db-table-group');
      const columnsEl = group.querySelector('.db-table-columns');
      const chevron = group.querySelector('.db-table-chevron');
      const connKey = group.dataset.connKey;
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
        const colResult = await window.api.dbGetColumns(tableName, connKey);

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
            dbRunQuery(tableName, col, op, val, 50, resultsDiv, connKey);
          });

          // Enter en el input
          valInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              const col = queryBar.querySelector('.db-query-col').value;
              const op = opSelect.value;
              dbRunQuery(tableName, col, op, valInput.value, 50, resultsDiv, connKey);
            }
          });

          // All rows
          queryBar.querySelector('.db-query-all').addEventListener('click', () => {
            dbRunQuery(tableName, '', '', '', 50, resultsDiv, connKey);
          });
        }
        columnsEl.dataset.loaded = 'true';
      }
    });
  });

  // Search/filter en tablas (Cmd+F)
  initDbSearch(container, totalTables);
}

function initDbSearch(container, totalCount) {
  const searchBar = document.getElementById('db-search-bar');
  const searchInput = document.getElementById('db-search-input');
  const searchCount = document.getElementById('db-search-count');
  const searchClose = document.getElementById('db-search-close');
  if (!searchBar || !searchInput) return;

  const groups = container.querySelectorAll('.db-table-group');
  const connGroups = container.querySelectorAll('.db-connection-group');

  function showDbSearch() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    searchInput.select();
  }

  function hideDbSearch() {
    searchBar.style.display = 'none';
    searchInput.value = '';
    searchCount.textContent = '';
    groups.forEach((g) => {
      g.style.display = '';
      // Limpiar highlights
      const nameEl = g.querySelector('.db-table-name');
      if (nameEl) {
        nameEl.querySelectorAll('.route-search-highlight').forEach((hl) => {
          hl.replaceWith(document.createTextNode(hl.textContent));
        });
        nameEl.normalize();
      }
    });
    // Mostrar todas las secciones de conexión
    connGroups.forEach((cg) => {
      cg.style.display = '';
      const body = cg.querySelector('.db-connection-body');
      if (body) body.style.display = '';
    });
    const headerCount = container.querySelector('.db-header-count');
    if (headerCount) headerCount.textContent = `${totalCount} tables`;
  }

  function filterTables() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      hideDbSearch();
      searchBar.style.display = 'flex';
      searchInput.focus();
      return;
    }

    let visible = 0;
    groups.forEach((g) => {
      const nameEl = g.querySelector('.db-table-name');
      const tableName = nameEl?.textContent || '';
      const matches = tableName.toLowerCase().includes(query);

      g.style.display = matches ? '' : 'none';
      if (matches) visible++;

      // Highlight
      if (nameEl) {
        nameEl.querySelectorAll('.route-search-highlight').forEach((hl) => {
          hl.replaceWith(document.createTextNode(hl.textContent));
        });
        nameEl.normalize();
        if (matches) {
          const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          nameEl.innerHTML = escapeHtml(tableName).replace(regex, '<span class="route-search-highlight">$1</span>');
        }
      }
    });

    // Mostrar/ocultar secciones de conexión según si tienen tablas visibles
    connGroups.forEach((cg) => {
      const visibleTables = cg.querySelectorAll('.db-table-group:not([style*="display: none"])');
      cg.style.display = visibleTables.length > 0 ? '' : 'none';
      // Expandir la sección si tiene resultados
      const body = cg.querySelector('.db-connection-body');
      if (body && visibleTables.length > 0) body.style.display = '';
    });

    searchCount.textContent = `${visible} / ${totalCount}`;
    const headerCount = container.querySelector('.db-header-count');
    if (headerCount) headerCount.textContent = `${visible} / ${totalCount} tables`;
  }

  searchInput.addEventListener('input', filterTables);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideDbSearch();
    }
  });

  searchClose.addEventListener('click', () => hideDbSearch());

  container._showDbSearch = showDbSearch;
}

async function dbRunQuery(tableName, column, operator, value, limit, resultsDiv, connKey) {
  resultsDiv.innerHTML = '<div class="db-col-loading">Querying...</div>';

  const result = await window.api.dbQuery(tableName, column, operator, value, limit, connKey);

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
    <div class="db-query-info">
      ${result.rows.length} row${result.rows.length !== 1 ? 's' : ''}${pkColumn ? ' — double-click cell to edit' : ''}
      <button class="db-btn-export-csv" data-table="${escapeAttr(tableName)}" data-conn-key="${escapeAttr(connKey || '')}" title="Export table as CSV">Export CSV</button>
    </div>
    <div class="db-results-table-wrap">
    <table class="db-results-table" data-table="${escapeAttr(tableName)}" data-pk="${escapeAttr(pkColumn || '')}" data-conn-key="${escapeAttr(connKey || '')}">
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

  // Export CSV de la tabla completa (no solo los rows visibles)
  const csvBtn = resultsDiv.querySelector('.db-btn-export-csv');
  if (csvBtn) {
    csvBtn.addEventListener('click', async () => {
      const tbl = csvBtn.dataset.table;
      const cKey = csvBtn.dataset.connKey || undefined;
      csvBtn.textContent = 'Exporting...';
      csvBtn.disabled = true;
      const res = await window.api.dbExport('csv', tbl, cKey);
      csvBtn.textContent = 'Export CSV';
      csvBtn.disabled = false;
      if (res.error) { alert(`Export failed:\n${res.error}`); return; }
      dbDownloadFile(res.filename, res.data);
    });
  }
}

/**
 * Descarga un string como archivo en el sistema de archivos del usuario
 * usando un <a download> temporal. Funciona dentro del contexto Electron
 * (el renderer tiene acceso al DOM y file:// URLs están permitidas).
 */
function dbDownloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Exporta el dump completo de la base de datos (mysqldump / pg_dump).
 *
 * Si hay múltiples conexiones, muestra un menú dropdown para que el
 * usuario elija cuál exportar, igual que phpMyAdmin cuando hay varias BDs.
 * Si hay una sola conexión, exporta directo sin preguntar.
 */
async function dbExportDump(connKey, connections) {
  const btn = document.getElementById('db-btn-dump');

  // Si hay múltiples conexiones, mostrar selector
  if (connections.length > 1 && !connKey) {
    const existing = document.getElementById('db-dump-menu');
    if (existing) { existing.remove(); return; }

    const menu = document.createElement('div');
    menu.id = 'db-dump-menu';
    menu.className = 'db-dump-menu';

    // Posicionar debajo del botón usando coordenadas absolutas
    const rect = btn.getBoundingClientRect();
    const container = document.getElementById('db-viewer-container');
    const containerRect = container.getBoundingClientRect();
    menu.style.top = (rect.bottom - containerRect.top) + 'px';
    menu.style.right = (containerRect.right - rect.right) + 'px';

    for (const conn of connections) {
      const item = document.createElement('div');
      item.className = 'db-dump-menu-item';
      item.textContent = conn.config.database;
      item.addEventListener('click', () => {
        menu.remove();
        dbExportDump(conn.key, connections);
      });
      menu.appendChild(item);
    }

    container.appendChild(menu);

    // Cerrar al hacer click fuera
    const close = (e) => {
      if (!menu.contains(e.target) && e.target !== btn) {
        menu.remove();
        document.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => document.addEventListener('click', close, true), 0);
    return;
  }

  if (btn) { btn.textContent = 'Dumping...'; btn.disabled = true; }
  const key = connKey || connections[0]?.key;
  const res = await window.api.dbExport('dump', null, key);
  if (btn) { btn.textContent = 'Export DB'; btn.disabled = false; }
  if (res.error) { alert(`Dump failed:\n${res.error}`); return; }
  dbDownloadFile(res.filename, res.data);
}

/**
 * Inicializa la consola SQL interactiva del DB viewer.
 *
 * La consola permite ejecutar SQL arbitrario (SELECT, UPDATE, DELETE, INSERT,
 * CREATE, DROP) contra cualquiera de las conexiones configuradas.
 * Cmd+Enter ejecuta la query. Los resultados SELECT se muestran como tabla;
 * los DML muestran filas afectadas.
 */
function initDbConsole(container, connections) {
  const consoleBtn = container.querySelector('#db-btn-console');
  const consolePanel = container.querySelector('#db-console');
  const runBtn = container.querySelector('#db-console-run');
  const clearBtn = container.querySelector('#db-console-clear');
  const input = container.querySelector('#db-console-input');
  const results = container.querySelector('#db-console-results');
  if (!consoleBtn || !consolePanel || !runBtn || !input || !results) return;

  // Toggle del panel al hacer click en el botón SQL
  consoleBtn.addEventListener('click', () => {
    const isOpen = consolePanel.style.display !== 'none';
    consolePanel.style.display = isOpen ? 'none' : '';
    consoleBtn.classList.toggle('db-btn-console-active', !isOpen);
    if (!isOpen) input.focus();
  });

  // Ejecutar query
  async function runQuery() {
    const sql = input.value.trim();
    if (!sql) return;

    const connKey = container.querySelector('#db-console-conn')?.value || undefined;
    results.innerHTML = '<div class="db-col-loading">Executing...</div>';
    runBtn.disabled = true;

    const res = await window.api.dbExecute(sql, connKey);
    runBtn.disabled = false;

    if (res.error) {
      results.innerHTML = `
        <div class="db-error" style="font-size:11px;padding:8px 12px">${escapeHtml(res.error)}</div>
        ${res.sql ? `<div class="db-query-sql">${escapeHtml(res.sql)}</div>` : ''}`;
      return;
    }

    // DML/DDL
    if (res.success) {
      const msg = res.affected !== null
        ? `${res.affected} row${res.affected !== 1 ? 's' : ''} affected`
        : 'Query executed successfully';
      results.innerHTML = `
        <div class="db-console-success">${msg}</div>
        <div class="db-query-sql">${escapeHtml(res.sql)}</div>`;
      return;
    }

    // SELECT — tabla de resultados
    if (!res.rows || res.rows.length === 0) {
      results.innerHTML = `
        <div class="db-query-sql">${escapeHtml(res.sql)}</div>
        <div class="db-col-loading">No results</div>`;
      return;
    }

    let tableHtml = `
      <div class="db-query-sql">${escapeHtml(res.sql)}</div>
      <div class="db-query-info">${res.rows.length} row${res.rows.length !== 1 ? 's' : ''}</div>
      <div class="db-results-table-wrap">
        <table class="db-results-table">
          <thead><tr>${res.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>`;
    for (const row of res.rows) {
      tableHtml += '<tr>' + row.map((cell) => {
        const isNull = cell === 'NULL' || cell === null || cell === undefined;
        return `<td${isNull ? ' class="db-cell-null"' : ''}>${isNull ? 'NULL' : escapeHtml(String(cell))}</td>`;
      }).join('') + '</tr>';
    }
    tableHtml += '</tbody></table></div>';
    results.innerHTML = tableHtml;
  }

  runBtn.addEventListener('click', runQuery);

  // Cmd+Enter para ejecutar, Tab inserta espacios
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runQuery();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.substring(0, start) + '  ' + input.value.substring(end);
      input.selectionStart = input.selectionEnd = start + 2;
    }
  });

  clearBtn.addEventListener('click', () => {
    results.innerHTML = '';
    input.value = '';
    input.focus();
  });
}

function dbStartCellEdit(td) {
  if (td.querySelector('input')) return; // Ya está editando

  const table = td.closest('table');
  const tableName = table.dataset.table;
  const pkColumn = table.dataset.pk;
  const connKey = table.dataset.connKey || undefined;
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
      isNull ? null : newValue, connKey
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
      <div class="route-search-bar" id="route-search-bar" style="display:none">
        <input id="route-search-input" type="text" placeholder="Filter routes..." autocomplete="off" spellcheck="false" />
        <span id="route-search-count" class="route-search-count"></span>
        <button id="route-search-close" class="route-search-close" title="Close (Esc)">&times;</button>
      </div>
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

  // Click en controller → resolver via PSR-4, fallback a búsqueda por nombre
  container.querySelectorAll('.route-clickable').forEach((row) => {
    row.addEventListener('click', async () => {
      const action = row.dataset.action;
      if (!action || !state.currentFolder) return;

      const controllerClass = action.split('@')[0];
      const classFileName = controllerClass.split('\\').pop() + '.php';

      // 1. Intentar resolver via PSR-4 (composer.json autoload)
      const resolved = await window.api.phpResolvePsr4Route(controllerClass);
      if (resolved && resolved.path) {
        openFile(resolved.path, classFileName);
        return;
      }

      // 2. Fallback: buscar el archivo por nombre en el proyecto
      const searchResult = await window.api.findFile(classFileName);
      if (searchResult && searchResult.path) {
        openFile(searchResult.path, classFileName);
        return;
      }

      // 3. Último fallback: construir path manual
      const root = state.projectCaps?.projectRoot || state.currentFolder;
      const filePath = controllerClass.replace(/\\/g, '/').replace(/^App\//, 'app/') + '.php';
      openFile(root + '/' + filePath, classFileName);
    });
  });

  // Search/filter en rutas (Cmd+F)
  initRouteSearch(container);
}

function initRouteSearch(container) {
  const searchBar = document.getElementById('route-search-bar');
  const searchInput = document.getElementById('route-search-input');
  const searchCount = document.getElementById('route-search-count');
  const searchClose = document.getElementById('route-search-close');
  if (!searchBar || !searchInput) return;

  const rows = container.querySelectorAll('.route-row');

  function showRouteSearch() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    searchInput.select();
  }

  function hideRouteSearch() {
    searchBar.style.display = 'none';
    searchInput.value = '';
    searchCount.textContent = '';
    rows.forEach((row) => {
      row.style.display = 'flex';
      // Limpiar highlights
      row.querySelectorAll('.route-search-highlight').forEach((hl) => {
        hl.replaceWith(document.createTextNode(hl.textContent));
      });
    });
    // Actualizar contador del header
    const headerCount = container.querySelector('.route-header-count');
    if (headerCount) headerCount.textContent = `${rows.length} routes`;
  }

  function filterRoutes() {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      hideRouteSearch();
      searchBar.style.display = 'flex';
      searchInput.focus();
      return;
    }

    let visible = 0;
    rows.forEach((row) => {
      // Buscar en URI, Name y Action (no en Method badges)
      const uri = row.querySelector('.route-col-uri');
      const name = row.querySelector('.route-col-name');
      const action = row.querySelector('.route-col-action');
      const method = row.querySelector('.route-col-method');

      const texts = [
        uri?.textContent || '',
        name?.textContent || '',
        action?.textContent || '',
        method?.textContent || '',
      ];

      const matches = texts.some((t) => t.toLowerCase().includes(query));
      row.style.display = matches ? 'flex' : 'none';
      if (matches) visible++;

      // Highlight matches en las columnas de texto
      [uri, name, action].forEach((col) => {
        if (!col) return;
        const original = col.textContent;
        // Limpiar highlights previos
        col.querySelectorAll('.route-search-highlight').forEach((hl) => {
          hl.replaceWith(document.createTextNode(hl.textContent));
        });
        col.normalize();
        if (!matches || !original.toLowerCase().includes(query)) return;

        // Aplicar highlight
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        col.innerHTML = escapeHtml(original).replace(regex, '<span class="route-search-highlight">$1</span>');
      });
    });

    searchCount.textContent = `${visible} / ${rows.length}`;
    const headerCount = container.querySelector('.route-header-count');
    if (headerCount) headerCount.textContent = `${visible} / ${rows.length} routes`;
  }

  searchInput.addEventListener('input', filterRoutes);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideRouteSearch();
    }
  });

  searchClose.addEventListener('click', () => hideRouteSearch());

  // Exponer la función para que Cmd+F pueda abrirla
  container._showRouteSearch = showRouteSearch;
}

function initDbAndRoutes() {
  window.api.onMenuDbViewer(() => openDbViewer());
  window.api.onMenuRouteList(() => openRouteList());
  document.getElementById('btn-open-db').addEventListener('click', () => openDbViewer());
  document.getElementById('btn-open-routes').addEventListener('click', () => openRouteList());
  document.getElementById('btn-open-logs').addEventListener('click', () => toggleLogPanel());
}

// ┌──────────────────────────────────────────────────┐
// │  LOG PANEL (sidebar)                              │
// │  Reemplaza el file tree (igual que Git y Search)  │
// │  con una lista de todos los archivos que hay en   │
// │  storage/logs. Al hacer click en uno se abre en   │
// │  un tab especial con vista formateada.            │
// └──────────────────────────────────────────────────┘

function toggleLogPanel() {
  if (state.sidebarView === 'logs') {
    showExplorerPanel();
  } else {
    showLogPanel();
  }
}

async function showLogPanel() {
  state.sidebarView = 'logs';
  hideAllSidebarPanels();
  document.getElementById('log-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent = 'LOGS';
  setActiveActionButton('btn-open-logs');
  await loadLogFileList();
}

async function loadLogFileList() {
  const list = document.getElementById('log-file-list');
  list.innerHTML = '<div class="db-loading">Loading...</div>';

  const result = await window.api.listLogs();
  if (result.error) {
    list.innerHTML = `<div class="db-error">${escapeHtml(result.error)}</div>`;
    return;
  }

  if (!result.files.length) {
    list.innerHTML = '<div class="db-loading" style="font-size:12px">No log files in storage/logs</div>';
    return;
  }

  let html = '';
  for (const file of result.files) {
    html += `<div class="log-file-item" data-path="${escapeAttr(file.path)}" title="${escapeAttr(file.path)}">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span>${escapeHtml(file.name)}</span>
    </div>`;
  }

  list.innerHTML = html;

  // Click en un log → abrirlo formateado en tab especial
  list.querySelectorAll('.log-file-item').forEach((item) => {
    item.addEventListener('click', () => {
      list.querySelectorAll('.log-file-item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      const filePath = item.dataset.path;
      const fileName = filePath.split(/[/\\]/).pop();
      openFormattedLog(filePath, fileName);
    });
  });
}

// ┌──────────────────────────────────────────────────┐
// │  LOG VIEWER (tab formateado)                      │
// │                                                   │
// │  Cuando el usuario clickea un archivo de log en   │
// │  el panel lateral, se abre acá como tab especial. │
// │                                                   │
// │  El contenido NO se muestra en Monaco (sería solo │
// │  texto plano), sino que se parsea el formato de   │
// │  log de Laravel:                                  │
// │    [2024-03-16 10:30:45] local.ERROR: message     │
// │                                                   │
// │  Y se muestra formateado con:                     │
// │  - Badges de color por nivel (ERROR, WARNING...)  │
// │  - Stack traces colapsables                       │
// │  - JSON embebido pretty-printed                   │
// │  - Filtros por nivel + búsqueda full-text         │
// └──────────────────────────────────────────────────┘

async function openFormattedLog(filePath, fileName) {
  const tabPath = `__log:${filePath}__`;
  const existing = state.openTabs.find((t) => t.path === tabPath);
  if (existing) {
    activateTab(existing);
    loadFormattedLog(filePath);
    return;
  }

  const tab = { path: tabPath, name: fileName, model: null, language: 'log', modified: false };
  state.openTabs.push(tab);
  activateTab(tab);
  loadFormattedLog(filePath);
}

async function loadFormattedLog(filePath) {
  const container = document.getElementById('log-viewer-container');
  container.innerHTML = '<div class="db-loading">Loading log...</div>';

  const result = await window.api.readLogTail(filePath, 2000);
  if (result.error) {
    container.innerHTML = `<div class="db-error">${escapeHtml(result.error)}</div>`;
    return;
  }

  const raw = result.content || '';
  const entries = parseLogEntries(raw);

  if (!entries.length) {
    container.innerHTML = '<div class="db-loading">Log file is empty</div>';
    return;
  }

  let html = `
    <div class="log-v-header">
      <span class="log-v-count">${entries.length} entries</span>
      <div class="log-v-filters">
        <button class="log-v-filter active" data-level="all">All</button>
        <button class="log-v-filter" data-level="ERROR">Error</button>
        <button class="log-v-filter" data-level="WARNING">Warning</button>
        <button class="log-v-filter" data-level="INFO">Info</button>
        <button class="log-v-filter" data-level="DEBUG">Debug</button>
      </div>
      <div class="log-v-search-box">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="log-v-search-input" type="text" placeholder="Search logs..." autocomplete="off" spellcheck="false" />
      </div>
      <button class="log-refresh-btn" title="Refresh">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
    </div>
    <div class="log-v-entries">`;

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const levelClass = `log-level-${(e.level || 'info').toLowerCase()}`;
    const hasStack = e.stack && e.stack.trim().length > 0;

    html += `<div class="log-v-entry ${levelClass}" data-level="${escapeAttr(e.level || '')}">
      <div class="log-v-entry-head">
        <span class="log-v-timestamp">${escapeHtml(e.timestamp || '')}</span>
        <span class="log-v-badge ${levelClass}">${escapeHtml(e.level || 'LOG')}</span>
        <span class="log-v-env">${escapeHtml(e.env || '')}</span>
        ${hasStack ? '<button class="log-v-toggle" title="Toggle stack trace">▸</button>' : ''}
        <span class="log-v-message">${formatLogMessage(e.message)}</span>
      </div>`;

    if (hasStack) {
      html += `<pre class="log-v-stack" style="display:none">${escapeHtml(e.stack)}</pre>`;
    }

    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;

  // Toggle stack traces
  container.querySelectorAll('.log-v-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const entry = btn.closest('.log-v-entry');
      const stack = entry.querySelector('.log-v-stack');
      if (!stack) return;
      const visible = stack.style.display !== 'none';
      stack.style.display = visible ? 'none' : 'block';
      btn.textContent = visible ? '▸' : '▾';
    });
  });

  // Level filters
  container.querySelectorAll('.log-v-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.log-v-filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      filterLogEntries(container, entries.length);
    });
  });

  // Search
  const searchInput = container.querySelector('.log-v-search-input');
  let searchTimeout = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => filterLogEntries(container, entries.length), 200);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      filterLogEntries(container, entries.length);
      searchInput.blur();
    }
  });

  // Refresh
  container.querySelector('.log-refresh-btn')?.addEventListener('click', () => {
    loadFormattedLog(filePath);
  });

  // Scroll to bottom (latest entries)
  const entriesDiv = container.querySelector('.log-v-entries');
  if (entriesDiv) entriesDiv.scrollTop = entriesDiv.scrollHeight;
}

/**
 * Filtrar entries del log viewer combinando nivel + texto.
 *
 * Se llama tanto al escribir en el buscador como al clickear
 * un filtro de nivel. Combina ambos criterios: una entry se
 * muestra solo si matchea el nivel activo Y contiene el texto
 * buscado.
 *
 * Si el match está dentro de un stack trace colapsado, lo
 * expande automáticamente para que el usuario vea dónde está.
 */
function filterLogEntries(container, totalCount) {
  const query = (container.querySelector('.log-v-search-input')?.value || '').trim().toLowerCase();
  const activeFilter = container.querySelector('.log-v-filter.active')?.dataset.level || 'all';
  const allEntries = container.querySelectorAll('.log-v-entry');
  let visible = 0;

  allEntries.forEach((entry) => {
    const levelMatch = activeFilter === 'all' || entry.dataset.level === activeFilter;
    let textMatch = true;
    if (query) {
      const text = entry.textContent.toLowerCase();
      textMatch = text.includes(query);
    }
    const show = levelMatch && textMatch;
    entry.style.display = show ? '' : 'none';
    if (show) visible++;

    // Limpiar highlights anteriores antes de aplicar nuevos
    entry.querySelectorAll('.log-search-hl').forEach((hl) => {
      hl.replaceWith(document.createTextNode(hl.textContent));
    });

    // Aplicar highlights en las entries visibles que matchean
    if (show && query) {
      highlightInElement(entry.querySelector('.log-v-message'), query);
      // Si el match está en el stack trace, expandirlo
      const stack = entry.querySelector('.log-v-stack');
      if (stack && stack.textContent.toLowerCase().includes(query)) {
        highlightInElement(stack, query);
        stack.style.display = 'block';
        const toggle = entry.querySelector('.log-v-toggle');
        if (toggle) toggle.textContent = '▾';
      }
    }
  });

  // Actualizar el contador: "15 / 230 entries" o "230 entries"
  const countEl = container.querySelector('.log-v-count');
  if (countEl) {
    countEl.textContent = (query || activeFilter !== 'all')
      ? `${visible} / ${totalCount} entries`
      : `${totalCount} entries`;
  }
}

/**
 * Resaltar todas las ocurrencias de `query` dentro de un elemento DOM.
 *
 * Recorre todos los nodos de texto del elemento y envuelve los matches
 * en <span class="log-search-hl"> para que CSS los pinte con fondo naranja.
 *
 * Usa TreeWalker para no pisar nodos que no sean texto (ej: spans de JSON).
 */
function highlightInElement(el, query) {
  if (!el) return;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  for (const node of textNodes) {
    if (!regex.test(node.textContent)) continue;
    const span = document.createElement('span');
    span.innerHTML = escapeHtml(node.textContent).replace(regex, '<span class="log-search-hl">$1</span>');
    node.replaceWith(span);
  }
}

/**
 * Formatear el mensaje de un entry de log.
 *
 * Busca objetos/arrays JSON embebidos en el texto del mensaje
 * (ej: {"user_id": 5, "action": "login"}) y los reemplaza con
 * versiones pretty-printed con indentación de 2 espacios.
 *
 * Si el JSON no se puede parsear (ej: es un string que casualmente
 * tiene llaves), lo deja tal cual sin romper nada.
 */
function formatLogMessage(message) {
  const jsonRegex = /(\{[\s\S]*\}|\[[\s\S]*\])/g;
  let lastIndex = 0;
  let result = '';
  let match;

  while ((match = jsonRegex.exec(message)) !== null) {
    // Text before JSON
    if (match.index > lastIndex) {
      result += escapeHtml(message.slice(lastIndex, match.index));
    }
    // Try to parse and pretty-print JSON
    try {
      const parsed = JSON.parse(match[1]);
      const pretty = JSON.stringify(parsed, null, 2);
      result += `<span class="log-json">${escapeHtml(pretty)}</span>`;
    } catch {
      result += escapeHtml(match[1]);
    }
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last JSON
  if (lastIndex < message.length) {
    result += escapeHtml(message.slice(lastIndex));
  }

  return result || escapeHtml(message);
}

/**
 * Parsear texto raw de un archivo de log en entries estructurados.
 *
 * El formato estándar de Laravel es:
 *   [2024-03-16 10:30:45] local.ERROR: SQLSTATE[42S02]: Base table not found
 *   #0 /var/www/app/Models/User.php(42): ...
 *   #1 /var/www/vendor/laravel/framework/...
 *
 * Cada línea que empieza con [timestamp] es una nueva entry.
 * Las líneas que siguen (sin timestamp) son parte del stack trace
 * de la entry anterior.
 *
 * También soporta archivos con líneas sueltas (sin el formato
 * de Laravel) — las trata como entries individuales sin nivel.
 */
function parseLogEntries(raw) {
  const entries = [];
  const entryRegex = /^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\]]*)\]\s+(\w+)\.(\w+):\s*(.*)/;
  const lines = raw.split('\n');
  let current = null;

  for (const line of lines) {
    const match = line.match(entryRegex);
    if (match) {
      // Nueva entry → guardar la anterior y empezar una nueva
      if (current) entries.push(current);
      current = {
        timestamp: match[1],
        env: match[2],           // ej: "local", "production"
        level: match[3].toUpperCase(), // ej: "ERROR", "INFO"
        message: match[4],
        stack: '',
      };
    } else if (current) {
      // Línea de continuación (stack trace, context, etc.)
      current.stack += (current.stack ? '\n' : '') + line;
    } else if (line.trim()) {
      // Líneas sueltas antes de cualquier entry con timestamp
      entries.push({
        timestamp: '',
        env: '',
        level: '',
        message: line,
        stack: '',
      });
    }
  }

  if (current) entries.push(current);
  return entries;
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

// ┌──────────────────────────────────────────────────┐
// │  CLAUDE PANEL (sidebar)                           │
// │  Panel de integración con Claude Code. Lee el     │
// │  directorio .claude del proyecto y muestra:       │
// │                                                   │
// │  SKILLS — .claude/skills/*/SKILL.md               │
// │    Skills custom del proyecto: instrucciones      │
// │    que Claude activa automáticamente según el     │
// │    contexto. Ej: laravel-migration, check-logs.   │
// │    También incluye slash commands del proyecto    │
// │    (.claude/commands/*.md).                       │
// │                                                   │
// │  AGENTS — .claude/agents/*.md                     │
// │    Agentes custom: subprocesos especializados     │
// │    con modelo, herramientas y color propios.      │
// │                                                   │
// │  Click en cualquier item → abre un dashboard      │
// │  de detalle en el área del editor (tab especial)  │
// │  con el contenido completo del archivo .md        │
// │  renderizado con Markdown básico.                 │
// └──────────────────────────────────────────────────┘

/**
 * Toggle del panel Claude en el sidebar.
 * Mismo patrón que toggleGitPanel / toggleSearchPanel:
 * si ya está activo, vuelve al explorer; si no, lo abre.
 */
function toggleClaudePanel() {
  if (state.sidebarView === 'claude') {
    showExplorerPanel();
  } else {
    showClaudePanel();
  }
}

/**
 * Activa el panel Claude en el sidebar.
 * Oculta todos los otros paneles, cambia el título del header
 * y dispara la carga de datos del directorio .claude.
 */
async function showClaudePanel() {
  state.sidebarView = 'claude';
  hideAllSidebarPanels();
  document.getElementById('claude-panel').style.display = 'flex';
  document.getElementById('sidebar-header').querySelector('span').textContent = 'CLAUDE';
  setActiveActionButton('btn-claude-panel');
  await renderClaudePanel();
}

/**
 * Carga y renderiza el panel lateral de Claude.
 *
 * Pide al main process los datos del directorio .claude via IPC
 * y construye el HTML de las secciones SKILLS y AGENTS.
 * Cada sección es colapsable y sus items son clickeables:
 * al hacer click se abre openClaudeDetail() en el área del editor.
 *
 * El panel guarda una referencia a los datos en panel._claudeData
 * para que los click handlers de los items puedan acceder al item
 * completo (incluyendo el body del .md) sin re-fetchear.
 */
async function renderClaudePanel() {
  const panel = document.getElementById('claude-panel');
  panel.innerHTML = '<div class="db-loading">Loading .claude...</div>';

  if (!state.currentFolder) {
    panel.innerHTML = '<div class="claude-empty">Open a folder to view Claude config</div>';
    return;
  }

  // Lanzar ambas peticiones IPC en paralelo:
  // - claudeRead: skills, commands, agents del directorio .claude
  // - claudeHistory: últimos 10 prompts humanos del proyecto
  const [data, historyResult] = await Promise.all([
    window.api.claudeRead(state.currentFolder),
    window.api.claudeHistory(state.currentFolder),
  ]);

  if (data.error) {
    panel.innerHTML = `<div class="db-error">${escapeHtml(data.error)}</div>`;
    return;
  }

  if (!data.exists) {
    panel.innerHTML = '<div class="claude-empty">No .claude directory found in this project</div>';
    return;
  }

  const agentColorMap = {
    red: 'var(--accent-red)',
    green: 'var(--accent-green)',
    yellow: 'var(--accent-yellow)',
    blue: 'var(--accent-blue)',
    cyan: 'var(--accent-teal)',
  };

  let html = '';

  /**
   * Genera el HTML de una sección colapsable del panel Claude.
   *
   * Cada sección tiene:
   *   - Un header clickeable con chevron, icono SVG, label y badge numérico
   *   - Un body con el contenido (bodyHtml) o un hint cuando está vacío
   *
   * El colapsado/expandido se gestiona en el event listener de más abajo
   * (no inline en el HTML) para mantener el HTML limpio.
   *
   * @param {string} id        - Identificador único usado en data-claude-section y data-claude-body
   * @param {string} icon      - SVG inline del icono del header
   * @param {string} label     - Texto del header en mayúsculas (ej: 'SKILLS')
   * @param {number} count     - Cantidad de items; si es 0 se muestra emptyHint en lugar de bodyHtml
   * @param {string} bodyHtml  - HTML del contenido de la sección cuando count > 0
   * @param {string} [emptyHint] - Texto a mostrar cuando count === 0 (opcional)
   * @returns {string} HTML completo de la sección
   */
  function claudeSection(id, icon, label, count, bodyHtml, emptyHint) {
    const hasContent = count > 0;
    const badge = count > 0 ? `<span class="claude-badge">${count}</span>` : '';
    const fallback = emptyHint || 'None configured in .claude/';
    return `<div class="claude-panel-section">
      <div class="claude-panel-section-header" data-claude-section="${id}">
        <span class="claude-panel-chevron">▾</span>
        ${icon}
        <span>${label}</span>
        ${badge}
      </div>
      <div class="claude-panel-section-body" data-claude-body="${id}">
        ${hasContent ? bodyHtml : `<div class="claude-empty-hint">${fallback}</div>`}
      </div>
    </div>`;
  }

  // ════════════════════════════════════════════
  // SKILLS — .claude/skills/*/SKILL.md + .claude/commands/*.md
  // ════════════════════════════════════════════
  let skillsHtml = '';
  for (const [i, s] of data.skills.entries()) {
    const versionBadge = s.version ? `<span class="claude-version-badge">v${escapeHtml(s.version)}</span>` : '';
    skillsHtml += `<div class="claude-item claude-item-clickable" data-claude-type="skill" data-claude-idx="${i}" title="${escapeAttr(s.description)}">
      <div class="claude-item-row">
        <span class="claude-item-name${s.isCommand ? ' claude-item-command' : ''}">${escapeHtml(s.name)}</span>
        ${versionBadge}
      </div>
      <span class="claude-item-desc">${escapeHtml(s.description)}</span>
    </div>`;
  }

  html += claudeSection(
    'skills',
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
    'SKILLS',
    data.skills.length,
    skillsHtml
  );

  // ════════════════════════════════════════════
  // AGENTS — .claude/agents/*.md
  // ════════════════════════════════════════════
  let agentsHtml = '';
  for (const [i, a] of data.agents.entries()) {
    const dotColor = agentColorMap[a.color] || 'var(--text-muted)';
    const modelBadge = a.model ? `<span class="claude-model-badge">${escapeHtml(a.model)}</span>` : '';
    agentsHtml += `<div class="claude-item claude-item-clickable" data-claude-type="agent" data-claude-idx="${i}" title="${escapeAttr(a.description)}">
      <div class="claude-item-row">
        <span class="claude-agent-dot" style="background:${dotColor}"></span>
        <span class="claude-item-name">${escapeHtml(a.name)}</span>
        ${modelBadge}
      </div>
      <span class="claude-item-desc">${escapeHtml(a.description)}</span>
    </div>`;
  }

  html += claudeSection(
    'agents',
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    'AGENTS',
    data.agents.length,
    agentsHtml
  );

  // ════════════════════════════════════════════
  // HISTORY — últimos 10 prompts de Claude Code
  // ════════════════════════════════════════════
  //
  // Los datos vienen de historyResult (respuesta del IPC claude:history).
  // Si la petición falló, historyResult.error tendrá el mensaje de error.
  // Si no hay historial para este proyecto, prompts será un array vacío.
  const prompts = (historyResult && historyResult.prompts) || [];

  // Si hubo un error en la petición IPC, loguearlo para facilitar el debug
  // (visible en DevTools > Console del renderer)
  if (historyResult && historyResult.error) {
    console.error('[Claude History]', historyResult.error);
  }

  /**
   * Formatea un timestamp ISO 8601 para mostrarlo en el panel lateral.
   *
   * La idea es mostrar info relevante sin desperdiciar espacio:
   * - Si es de hoy: solo la hora (HH:MM), porque la fecha es obvia
   * - Si es de otro día: fecha corta (ej: "Mar 17"), sin hora
   *
   * @param {string} isoString - Timestamp en formato ISO 8601
   * @returns {string} Cadena formateada lista para insertar en HTML
   */
  function formatTs(isoString) {
    if (!isoString) return '';
    const d   = new Date(isoString);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  // ── Construir los items del historial ────────────────────────────────
  //
  // Cada item muestra:
  //   - Timestamp a la derecha (hora o fecha según antigüedad)
  //   - Hasta 4 líneas del prompt (CSS clamp)
  //   - 1 línea del snippet de respuesta en gris/itálica (opcional)
  //
  // El data-history-idx permite al click handler recuperar el item completo
  // de panel._historyData sin re-fetchear al main process.
  let historyHtml = '';
  for (const [i, p] of prompts.entries()) {
    const ts = formatTs(p.timestamp);
    const promptPreview = escapeHtml(p.prompt.slice(0, 200));
    const respPreview   = p.response
      ? escapeHtml(p.response.slice(0, 120).replace(/\n+/g, ' '))
      : '';
    historyHtml += `<div class="claude-item history-item" data-history-idx="${i}">
      <div class="history-item-header">
        <span class="history-item-ts">${ts}</span>
      </div>
      <div class="history-item-prompt">${promptPreview}</div>
      ${respPreview ? `<div class="history-item-response">${respPreview}</div>` : ''}
    </div>`;
  }

  // Hint vacío personalizado: distingue "sin historial" de "error de API"
  const historyEmptyHint = (historyResult && historyResult.error)
    ? `Error: ${escapeHtml(historyResult.error)}`
    : 'No conversations found for this project';

  html += claudeSection(
    'history',
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    'HISTORY',
    prompts.length,
    historyHtml,
    historyEmptyHint
  );

  // Guardar data para que los click handlers puedan acceder al contenido completo
  panel._claudeData   = data;
  panel._historyData  = prompts;

  panel.innerHTML = html;

  // ── Colapsable: toggle al clickear el header ──
  panel.querySelectorAll('.claude-panel-section-header').forEach((header) => {
    header.addEventListener('click', () => {
      const body = panel.querySelector(`[data-claude-body="${header.dataset.claudeSection}"]`);
      const chevron = header.querySelector('.claude-panel-chevron');
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      chevron.textContent = collapsed ? '▾' : '▸';
    });
  });

  // ── Click en skill/agent → abrir dashboard de detalle ──
  panel.querySelectorAll('.claude-item[data-claude-type]').forEach((el) => {
    el.addEventListener('click', () => {
      const type = el.dataset.claudeType;
      const idx  = parseInt(el.dataset.claudeIdx, 10);
      const item = type === 'skill' ? data.skills[idx] : data.agents[idx];
      if (item) openClaudeDetail(item, type);
    });
  });

  // ── Click en prompt del historial → abrir detalle ──
  panel.querySelectorAll('.history-item[data-history-idx]').forEach((el) => {
    el.addEventListener('click', () => {
      const idx  = parseInt(el.dataset.historyIdx, 10);
      const item = prompts[idx];
      if (item) openHistoryDetail(item);
    });
  });
}

/**
 * Abre (o reactiva) el tab de detalle de un skill/agente.
 *
 * El tab path tiene la forma __claude-detail__:skill:nombre
 * para que el registry de specialTabs lo reconozca y muestre
 * claude-detail-container en el área del editor.
 *
 * Si el tab ya existe, lo activa sin crear un duplicado.
 * En ambos casos llama a renderClaudeDetail() para actualizar el contenido,
 * lo que permite hacer click en distintos items y ver el detalle en el mismo tab.
 *
 * @param {Object} item - El objeto skill o agent (con name, description, body, etc.)
 * @param {string} type - 'skill' o 'agent'
 */
function openClaudeDetail(item, type) {
  const tabPath = `__claude-detail__:${type}:${item.name}`;
  const existing = state.openTabs.find((t) => t.path === tabPath);
  if (existing) {
    activateTab(existing);
  } else {
    const tab = { path: tabPath, name: item.name, model: null, language: 'claude', modified: false };
    state.openTabs.push(tab);
    activateTab(tab);
  }
  renderClaudeDetail(item, type);
}

/**
 * Renderiza el cuerpo Markdown de un skill/agente a HTML seguro.
 *
 * Soporta el subconjunto de Markdown usado habitualmente en SKILL.md y
 * archivos de agentes: bloques de código con triple backtick, encabezados
 * h1/h2/h3, listas ordenadas y sin orden, líneas en blanco como separadores,
 * y párrafos normales.  El formato inline (bold, italic, code) se delega a
 * inlineMarkdown().
 *
 * @param {string} text - Contenido Markdown puro (sin frontmatter)
 * @returns {string} HTML listo para inyectar en .cd-body
 */
function renderClaudeMarkdown(text) {
  if (!text) return '';
  let html = '';
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines = [];

  for (const raw of lines) {
    // Code fence start/end
    const fenceMatch = raw.match(/^```(\w*)/);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      codeLang = fenceMatch[1];
      codeLines = [];
      continue;
    }
    if (raw.trimEnd() === '```' && inCodeBlock) {
      inCodeBlock = false;
      html += `<pre class="cd-code"><code class="cd-code-lang-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`;
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    // Headers
    const h3 = raw.match(/^### (.+)/);
    const h2 = raw.match(/^## (.+)/);
    const h1 = raw.match(/^# (.+)/);
    if (h1) { html += `<h1 class="cd-h1">${inlineMarkdown(h1[1])}</h1>`; continue; }
    if (h2) { html += `<h2 class="cd-h2">${inlineMarkdown(h2[1])}</h2>`; continue; }
    if (h3) { html += `<h3 class="cd-h3">${inlineMarkdown(h3[1])}</h3>`; continue; }

    // List items
    const li = raw.match(/^[-*] (.+)/);
    if (li) { html += `<div class="cd-li"><span class="cd-bullet">•</span>${inlineMarkdown(li[1])}</div>`; continue; }

    // Numbered list
    const oli = raw.match(/^\d+\. (.+)/);
    if (oli) { html += `<div class="cd-li"><span class="cd-bullet cd-num">${raw.match(/^(\d+)\./)[1]}.</span>${inlineMarkdown(oli[1])}</div>`; continue; }

    // Blank line → spacer
    if (raw.trim() === '') { html += '<div class="cd-spacer"></div>'; continue; }

    // Normal paragraph line
    html += `<p class="cd-p">${inlineMarkdown(raw)}</p>`;
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length) {
    html += `<pre class="cd-code"><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
  }

  return html;
}

/**
 * Aplica formato inline Markdown a una línea de texto ya escapada.
 *
 * Transforma **bold**, *italic* y `inline code` a sus equivalentes HTML.
 * Se llama desde renderClaudeMarkdown() sobre cada línea antes de emitirla,
 * por lo que el texto de entrada ya pasó por escapeHtml().
 *
 * @param {string} text - Texto plano (sin HTML previo)
 * @returns {string} Texto con tags <strong>, <em> y <code> insertados
 */
function inlineMarkdown(text) {
  return escapeHtml(text)
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // *italic*
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // `inline code`
    .replace(/`([^`]+)`/g, '<code class="cd-inline-code">$1</code>');
}

/**
 * Renderiza el dashboard de detalle de un skill o agente en claude-detail-container.
 *
 * LAYOUT:
 *   ┌─ Header ─────────────────────────────────────┐
 *   │  ● nombre   [tipo]  [modelo/versión]          │
 *   │  Descripción completa                         │
 *   │  [tool] [tool] [tool]                         │
 *   ├──────────────────────────────────────────────┤
 *   │  Cuerpo del archivo .md renderizado           │
 *   │  (headers, bold, code blocks, listas)         │
 *   └──────────────────────────────────────────────┘
 *
 * El punto de color (cd-dot) se muestra solo para agentes que tienen
 * un color definido en su frontmatter.  Los badges de modelo y versión
 * son opcionales y solo aparecen si el item los tiene.
 *
 * @param {Object} item - El objeto skill o agent (con name, description, body, etc.)
 * @param {string} type - 'skill', 'agent' o 'command'
 */
function renderClaudeDetail(item, type) {
  const container = document.getElementById('claude-detail-container');

  const agentColorMap = {
    red: 'var(--accent-red)',
    green: 'var(--accent-green)',
    yellow: 'var(--accent-yellow)',
    blue: 'var(--accent-blue)',
    cyan: 'var(--accent-teal)',
  };

  // ── Header ──
  const isAgent  = type === 'agent';
  const dotColor = isAgent && item.color ? agentColorMap[item.color] || 'var(--text-muted)' : null;
  const dotHtml  = dotColor ? `<span class="cd-dot" style="background:${dotColor}"></span>` : '';

  const modelBadge = item.model
    ? `<span class="cd-meta-badge">${escapeHtml(item.model)}</span>` : '';
  const versionBadge = item.version
    ? `<span class="cd-meta-badge">v${escapeHtml(item.version)}</span>` : '';
  const typeBadge = `<span class="cd-type-badge cd-type-${type}">${isAgent ? 'agent' : (item.isCommand ? 'command' : 'skill')}</span>`;

  // ── Tools ──
  const toolsHtml = item.tools
    ? `<div class="cd-tools-row">${item.tools.split(',').map((t) =>
        `<span class="cd-tool-chip">${escapeHtml(t.trim())}</span>`).join('')}</div>` : '';

  container.innerHTML = `
    <div class="cd-root">
      <div class="cd-header">
        <div class="cd-title-row">
          ${dotHtml}
          <h1 class="cd-title">${escapeHtml(item.name)}</h1>
          ${typeBadge}
          ${modelBadge}
          ${versionBadge}
        </div>
        <p class="cd-description">${escapeHtml(item.description)}</p>
        ${toolsHtml}
      </div>
      <div class="cd-divider"></div>
      <div class="cd-body">${renderClaudeMarkdown(item.body)}</div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════
// SECCIÓN 22 — HISTORIAL DE PROMPTS DE CLAUDE CODE
//
// Los últimos 10 prompts se muestran como tercera sección
// colapsable dentro del panel Claude (al lado de SKILLS y AGENTS).
// Al hacer click en un prompt, se abre un tab de detalle en el
// editor con el prompt completo y la respuesta de Claude.
//
// Flujo:
//   renderClaudePanel()  →  window.api.claudeHistory()  (IPC)
//   click en prompt      →  openHistoryDetail(item)
//   openHistoryDetail    →  activateTab() + renderHistoryDetail(item)
// ══════════════════════════════════════════════════════════════

/**
 * Abre (o reactiva) el tab de detalle de un prompt.
 *
 * El path del tab es __history-detail__:<uuid> para que el registry
 * de specialTabs lo reconozca y muestre history-detail-container.
 *
 * Si el tab ya existe, lo activa.  En ambos casos renderiza el detalle.
 *
 * @param {Object} item - Objeto con { uuid, prompt, response, timestamp }
 */
function openHistoryDetail(item) {
  const tabPath = `__history-detail__:${item.uuid}`;
  const existing = state.openTabs.find((t) => t.path === tabPath);
  if (existing) {
    activateTab(existing);
  } else {
    const label = item.prompt.split('\n')[0].slice(0, 40) || 'Prompt';
    const tab = { path: tabPath, name: label, model: null, language: 'history', modified: false };
    state.openTabs.push(tab);
    activateTab(tab);
  }
  renderHistoryDetail(item);
}

/**
 * Renderiza el detalle de un prompt en history-detail-container.
 *
 * LAYOUT:
 *   ┌─ Header ─────────────────────────────────────────────┐
 *   │  [USER]  timestamp                                    │
 *   │  Texto completo del prompt                            │
 *   ├──────────────────────────────────────────────────────┤
 *   │  [CLAUDE]                                             │
 *   │  Respuesta completa con Markdown renderizado          │
 *   └──────────────────────────────────────────────────────┘
 *
 * @param {Object} item - Objeto con { uuid, prompt, response, timestamp }
 */
function renderHistoryDetail(item) {
  const container = document.getElementById('history-detail-container');

  // Formatear fecha completa para el detalle
  const dateStr = item.timestamp
    ? new Date(item.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : '';

  const responseHtml = item.response
    ? renderClaudeMarkdown(item.response)
    : '<p class="cd-p" style="opacity:0.5">No response recorded</p>';

  container.innerHTML = `
    <div class="cd-root hd-root">
      <div class="hd-block hd-user">
        <div class="hd-role-row">
          <span class="hd-role-badge hd-role-user">YOU</span>
          <span class="hd-ts">${escapeHtml(dateStr)}</span>
        </div>
        <pre class="hd-prompt-text">${escapeHtml(item.prompt)}</pre>
      </div>
      <div class="cd-divider"></div>
      <div class="hd-block hd-assistant">
        <div class="hd-role-row">
          <span class="hd-role-badge hd-role-claude">CLAUDE</span>
        </div>
        <div class="cd-body">${responseHtml}</div>
      </div>
    </div>
  `;
}

/**
 * Conecta el botón del panel Claude en la barra de acción de la sidebar.
 *
 * El botón (btn-claude-panel) alterna entre el panel de explorador de archivos
 * y el panel de integración con Claude Code.  Se llama una sola vez desde init().
 */
function initClaudePanel() {
  document.getElementById('btn-claude-panel').addEventListener('click', () => toggleClaudePanel());
}

// ┌──────────────────────────────────────────────────┐
// │  HAMBURGER MENU (Windows/Linux)                  │
// │  Renderiza el menú nativo de Electron como un    │
// │  dropdown HTML en el titlebar. Solo se activa    │
// │  en plataformas sin barra de menú nativa.        │
// │                                                  │
// │  FLUJO:                                          │
// │  1. Main envía 'menu:structure' con la estructura│
// │     serializada cada vez que se reconstruye.     │
// │  2. Renderer renderiza las top-level labels como │
// │     una barra horizontal. Click en una abre su   │
// │     submenu.                                     │
// │  3. Click en un item → 'menu:execute' al main    │
// │     con el path de labels (['File','Save']).     │
// │  4. Main busca el item en Menu.getApplicationMenu│
// │     y ejecuta su click handler nativo.           │
// └──────────────────────────────────────────────────┘
function initHamburgerMenu() {
  const btn = document.getElementById('titlebar-menu-btn');
  const dropdown = document.getElementById('titlebar-menu-dropdown');
  let menuData = [];
  let isOpen = false;
  let activeTopIndex = -1;

  // Mostrar el botón hamburguesa
  btn.style.display = 'flex';

  // Cerrar el menú al hacer click fuera
  document.addEventListener('mousedown', (e) => {
    if (isOpen && !dropdown.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
      closeMenu();
    }
  });

  // Cerrar con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) closeMenu();
  });

  // Toggle menú al clickear hamburguesa
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isOpen) { closeMenu(); } else { openMenu(); }
  });

  function closeMenu() {
    dropdown.style.display = 'none';
    isOpen = false;
    activeTopIndex = -1;
  }

  function openMenu() {
    if (menuData.length === 0) {
      window.api.menuRequestStructure();
      return;
    }
    renderMenu();
    dropdown.style.display = 'block';
    isOpen = true;
  }

  function renderMenu() {
    // Barra horizontal con los items de primer nivel (File, Edit, View...)
    let html = '<div class="menu-bar">';
    menuData.forEach((top, i) => {
      if (top.type === 'separator') return;
      html += `<div class="menu-bar-item${i === activeTopIndex ? ' active' : ''}" data-index="${i}">${escapeHtml(top.label)}</div>`;
    });
    html += '</div>';

    // Submenu del item activo
    if (activeTopIndex >= 0 && menuData[activeTopIndex]?.submenu) {
      html += '<div class="menu-submenu">';
      html += renderSubmenuItems(menuData[activeTopIndex].submenu, [menuData[activeTopIndex].label]);
      html += '</div>';
    }

    dropdown.innerHTML = html;

    // Event delegation para los items de la barra
    dropdown.querySelectorAll('.menu-bar-item').forEach(el => {
      el.addEventListener('mouseenter', () => {
        if (isOpen && activeTopIndex >= 0) {
          activeTopIndex = parseInt(el.dataset.index);
          renderMenu();
        }
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(el.dataset.index);
        if (activeTopIndex === idx) {
          activeTopIndex = -1;
        } else {
          activeTopIndex = idx;
        }
        renderMenu();
      });
    });

    // Event delegation para los items del submenu
    dropdown.querySelectorAll('.menu-item[data-path]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el.classList.contains('disabled') || el.classList.contains('has-submenu')) return;
        const path = JSON.parse(el.dataset.path);
        window.api.menuExecute(path);
        closeMenu();
      });
    });
  }

  function renderSubmenuItems(items, parentPath) {
    let html = '';
    for (const item of items) {
      if (item.type === 'separator') {
        html += '<div class="menu-separator"></div>';
        continue;
      }
      if (!item.label) continue;

      const currentPath = [...parentPath, item.label];
      const hasSubmenu = item.submenu && item.submenu.length > 0;
      const classes = ['menu-item'];
      if (!item.enabled) classes.push('disabled');
      if (item.checked) classes.push('checked');
      if (hasSubmenu) classes.push('has-submenu');

      const accel = item.accelerator ? `<span class="menu-item-accel">${escapeHtml(item.accelerator)}</span>` : '';

      html += `<div class="${classes.join(' ')}" data-path='${JSON.stringify(currentPath)}'>`;
      html += `<span>${escapeHtml(item.label)}</span>${accel}`;

      if (hasSubmenu) {
        html += '<div class="menu-nested">';
        html += renderSubmenuItems(item.submenu, currentPath);
        html += '</div>';
      }

      html += '</div>';
    }
    return html;
  }

  // Recibir estructura del menú desde el main process
  window.api.onMenuStructure((data) => {
    menuData = data;
    // Si el menú está abierto, re-renderizarlo (e.g. después de detectar proyecto)
    if (isOpen) renderMenu();
  });

  // Pedir la estructura del menú al iniciar
  window.api.menuRequestStructure();
}

(function init() {
  initEditor();
  initThemeMenu();
  initSidebarSections();
  initEventListeners();
  initGitPanel();
  initDebugPanel();
  initErrorLog();
  initTerminal(); // async, no bloqueante
  initQuickOpen();
  initSearchPanel();
  initSymbolSearch();
  initCommandPalette();
  initComposerArtisan();
  initPhpTools();
  initDbAndRoutes();
  initClaudePanel();
  initSplitEditor();
  initTreeContextMenu();
  initSidebarResize();
  renderRecentFolders(); // Mostrar carpetas recientes en la welcome screen
  initSystemMonitor();
})();
