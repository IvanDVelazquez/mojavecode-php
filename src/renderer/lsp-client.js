/**
 * ══════════════════════════════════════════════════════════════
 * LSP CLIENT — Conecta Monaco Editor con el servidor LSP
 * ══════════════════════════════════════════════════════════════
 *
 * Este módulo registra providers de Monaco (completion, hover,
 * definition, diagnostics) que se comunican con Intelephense
 * via IPC. También maneja la sincronización de documentos.
 *
 * POSICIONES:
 * LSP usa 0-based (line, character)
 * Monaco usa 1-based (lineNumber, column)
 */

// ┌──────────────────────────────────────────────────┐
// │  ESTADO DEL LSP CLIENT                           │
// └──────────────────────────────────────────────────┘
const lspState = {
  ready: false,
  documentVersions: new Map(), // uri -> version counter
  changeListeners: new Map(),  // uri -> disposable
};

// ┌──────────────────────────────────────────────────┐
// │  CONVERSIÓN DE POSICIONES LSP <-> MONACO         │
// └──────────────────────────────────────────────────┘
function lspToMonacoRange(range) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function monacoToLspPosition(position) {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  };
}

// ┌──────────────────────────────────────────────────┐
// │  MAPEO DE TIPOS LSP -> MONACO                    │
// └──────────────────────────────────────────────────┘

// LSP CompletionItemKind -> Monaco CompletionItemKind
function mapCompletionKind(lspKind) {
  const map = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter,
  };
  return map[lspKind] || monaco.languages.CompletionItemKind.Text;
}

// LSP DiagnosticSeverity -> Monaco MarkerSeverity
function mapDiagnosticSeverity(lspSeverity) {
  const map = {
    1: monaco.MarkerSeverity.Error,
    2: monaco.MarkerSeverity.Warning,
    3: monaco.MarkerSeverity.Info,
    4: monaco.MarkerSeverity.Hint,
  };
  return map[lspSeverity] || monaco.MarkerSeverity.Info;
}

// ┌──────────────────────────────────────────────────┐
// │  DOCUMENT SYNC — Notificar al LSP de cambios     │
// └──────────────────────────────────────────────────┘
function lspDidOpen(uri, languageId, content) {
  if (!lspState.ready) return;
  const version = 1;
  lspState.documentVersions.set(uri, version);

  window.api.lspNotify('textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version,
      text: content,
    },
  });
}

function lspDidChange(uri, content) {
  if (!lspState.ready) return;
  const version = (lspState.documentVersions.get(uri) || 0) + 1;
  lspState.documentVersions.set(uri, version);

  window.api.lspNotify('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text: content }], // Full sync
  });
}

function lspDidClose(uri) {
  if (!lspState.ready) return;
  lspState.documentVersions.delete(uri);

  window.api.lspNotify('textDocument/didClose', {
    textDocument: { uri },
  });

  // Limpiar change listener
  const disposable = lspState.changeListeners.get(uri);
  if (disposable) {
    disposable.dispose();
    lspState.changeListeners.delete(uri);
  }

  // Limpiar markers
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model) {
    monaco.editor.setModelMarkers(model, 'intelephense', []);
  }
}

function lspDidSave(uri, content) {
  if (!lspState.ready) return;

  window.api.lspNotify('textDocument/didSave', {
    textDocument: { uri },
    text: content,
  });
}

/**
 * Registrar un modelo PHP para sync con el LSP.
 * Se llama desde openFile() en renderer.js
 */
function lspTrackModel(model, languageId) {
  if (!lspState.ready) return;

  // Solo trackear PHP (incluye blade.php)
  const isPhp = languageId === 'php' || model.uri.path.endsWith('.php');
  if (!isPhp) return;

  const uri = model.uri.toString();

  // didOpen
  lspDidOpen(uri, 'php', model.getValue());

  // didChange en cada edición
  const disposable = model.onDidChangeContent(() => {
    lspDidChange(uri, model.getValue());
  });
  lspState.changeListeners.set(uri, disposable);
}

/**
 * Dejar de trackear un modelo (al cerrar tab).
 */
function lspUntrackModel(model) {
  if (!model) return;
  const uri = model.uri.toString();
  if (lspState.documentVersions.has(uri)) {
    lspDidClose(uri);
  }
}

// ┌──────────────────────────────────────────────────┐
// │  MONACO PROVIDERS — Autocompletado, Hover, etc.  │
// └──────────────────────────────────────────────────┘
function initLspProviders() {
  // ── COMPLETION ──
  monaco.languages.registerCompletionItemProvider('php', {
    triggerCharacters: ['>', '$', ':', '\\', '/', '@', '_'],

    async provideCompletionItems(model, position) {
      if (!lspState.ready) return { suggestions: [] };

      try {
        const response = await window.api.lspRequest('textDocument/completion', {
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
        });

        if (!response) return { suggestions: [] };

        const items = response.items || response;
        if (!Array.isArray(items)) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        return {
          suggestions: items.map((item) => {
            const suggestion = {
              label: item.label,
              kind: mapCompletionKind(item.kind),
              insertText: item.textEdit?.newText || item.insertText || item.label,
              insertTextRules: item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              detail: item.detail || '',
              documentation: item.documentation
                ? { value: item.documentation.value || item.documentation }
                : undefined,
              sortText: item.sortText,
              filterText: item.filterText,
              range: item.textEdit?.range ? lspToMonacoRange(item.textEdit.range) : range,
              _lspItem: item, // Guardar para resolve
            };
            return suggestion;
          }),
        };
      } catch (err) {
        console.error('[LSP] Completion error:', err);
        return { suggestions: [] };
      }
    },

    async resolveCompletionItem(item) {
      if (!lspState.ready || !item._lspItem) return item;

      try {
        const resolved = await window.api.lspRequest('completionItem/resolve', item._lspItem);
        if (resolved?.documentation) {
          item.documentation = {
            value: resolved.documentation.value || String(resolved.documentation),
          };
        }
        if (resolved?.detail) {
          item.detail = resolved.detail;
        }
      } catch (err) {
        // Silencioso — resolve es opcional
      }
      return item;
    },
  });

  // ── HOVER ──
  monaco.languages.registerHoverProvider('php', {
    async provideHover(model, position) {
      if (!lspState.ready) return null;

      try {
        const response = await window.api.lspRequest('textDocument/hover', {
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
        });

        if (!response || !response.contents) return null;

        // contents puede ser MarkupContent, string, o array
        let contents;
        if (typeof response.contents === 'string') {
          contents = [{ value: response.contents }];
        } else if (response.contents.value) {
          contents = [{ value: response.contents.value }];
        } else if (Array.isArray(response.contents)) {
          contents = response.contents.map((c) =>
            typeof c === 'string' ? { value: c } : { value: c.value || String(c) }
          );
        } else {
          contents = [{ value: String(response.contents) }];
        }

        return {
          contents,
          range: response.range ? lspToMonacoRange(response.range) : undefined,
        };
      } catch (err) {
        console.error('[LSP] Hover error:', err);
        return null;
      }
    },
  });

  // ── GO TO DEFINITION ──
  monaco.languages.registerDefinitionProvider('php', {
    async provideDefinition(model, position) {
      if (!lspState.ready) return null;

      try {
        const response = await window.api.lspRequest('textDocument/definition', {
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
        });

        if (!response) return null;

        const locations = Array.isArray(response) ? response : [response];

        // Pre-crear modelos para archivos que no están abiertos
        // Esto evita "Model not found" cuando Monaco hace peek/hover
        for (const loc of locations) {
          const locUri = monaco.Uri.parse(loc.uri);
          if (!monaco.editor.getModel(locUri)) {
            try {
              const filePath = locUri.path;
              const fileResult = await window.api.readFile(filePath);
              if (!fileResult.error) {
                const ext = filePath.split('.').pop();
                const lang = getMonacoLanguage(ext);
                monaco.editor.createModel(fileResult.content, lang, locUri);
              }
            } catch (e) {
              // Silencioso — si falla, Monaco simplemente no mostrará el preview
            }
          }
        }

        return locations.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: lspToMonacoRange(loc.range),
        }));
      } catch (err) {
        console.error('[LSP] Definition error:', err);
        return null;
      }
    },
  });

  // ── SIGNATURE HELP ──
  monaco.languages.registerSignatureHelpProvider('php', {
    signatureHelpTriggerCharacters: ['(', ','],

    async provideSignatureHelp(model, position) {
      if (!lspState.ready) return null;

      try {
        const response = await window.api.lspRequest('textDocument/signatureHelp', {
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
        });

        if (!response || !response.signatures?.length) return null;

        return {
          value: {
            signatures: response.signatures.map((sig) => ({
              label: sig.label,
              documentation: sig.documentation
                ? { value: sig.documentation.value || sig.documentation }
                : undefined,
              parameters: (sig.parameters || []).map((p) => ({
                label: p.label,
                documentation: p.documentation
                  ? { value: p.documentation.value || p.documentation }
                  : undefined,
              })),
            })),
            activeSignature: response.activeSignature || 0,
            activeParameter: response.activeParameter || 0,
          },
          dispose: () => {},
        };
      } catch (err) {
        return null;
      }
    },
  });

  // ── EDITOR OPENER — Abrir archivos desde go-to-definition ──
  monaco.editor.registerEditorOpener({
    async openCodeEditor(source, resource, selectionOrPosition) {
      const filePath = resource.path;

      // Abrir el archivo como un tab nuevo (o activar si ya está abierto)
      const fileName = filePath.split(/[/\\]/).pop();
      await openFile(filePath, fileName);

      // Mover el cursor a la posición/rango indicado
      if (selectionOrPosition && state.editor) {
        if (selectionOrPosition.startLineNumber) {
          // Es un Range
          state.editor.setSelection(selectionOrPosition);
          state.editor.revealRangeInCenter(selectionOrPosition);
        } else if (selectionOrPosition.lineNumber) {
          // Es una Position
          state.editor.setPosition(selectionOrPosition);
          state.editor.revealPositionInCenter(selectionOrPosition);
        }
      }

      return true; // Indica que nosotros manejamos la apertura
    },
  });

  // ── DIAGNOSTICS (notificaciones del servidor) ──
  window.api.onLspNotification((message) => {
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params;
      const modelUri = monaco.Uri.parse(uri);
      const model = monaco.editor.getModel(modelUri);

      if (model) {
        const markers = diagnostics.map((d) => ({
          severity: mapDiagnosticSeverity(d.severity),
          message: d.message,
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          source: d.source || 'intelephense',
          code: d.code,
        }));
        monaco.editor.setModelMarkers(model, 'intelephense', markers);
      }
    }
  });
}

// ┌──────────────────────────────────────────────────┐
// │  BLADE DIRECTIVES — Autocompletado estático      │
// └──────────────────────────────────────────────────┘
function initBladeCompletions() {
  const bladeDirectives = [
    // Control
    { label: '@if', insertText: '@if(${1:condition})\n\t$0\n@endif', doc: 'Conditional block' },
    { label: '@elseif', insertText: '@elseif(${1:condition})', doc: 'Else-if condition' },
    { label: '@else', insertText: '@else', doc: 'Else block' },
    { label: '@unless', insertText: '@unless(${1:condition})\n\t$0\n@endunless', doc: 'Unless block' },
    { label: '@isset', insertText: '@isset(${1:\\$variable})\n\t$0\n@endisset', doc: 'Isset check' },
    { label: '@empty', insertText: '@empty(${1:\\$variable})\n\t$0\n@endempty', doc: 'Empty check' },
    { label: '@switch', insertText: '@switch(${1:\\$variable})\n\t@case(${2:value})\n\t\t$0\n\t\t@break\n\t@default\n\t\t\n@endswitch', doc: 'Switch statement' },

    // Loops
    { label: '@foreach', insertText: '@foreach(${1:\\$items} as ${2:\\$item})\n\t$0\n@endforeach', doc: 'Foreach loop' },
    { label: '@forelse', insertText: '@forelse(${1:\\$items} as ${2:\\$item})\n\t$0\n@empty\n\t\n@endforelse', doc: 'Forelse loop (with empty fallback)' },
    { label: '@for', insertText: '@for(${1:\\$i = 0; \\$i < count; \\$i++})\n\t$0\n@endfor', doc: 'For loop' },
    { label: '@while', insertText: '@while(${1:condition})\n\t$0\n@endwhile', doc: 'While loop' },
    { label: '@continue', insertText: '@continue', doc: 'Continue loop iteration' },
    { label: '@break', insertText: '@break', doc: 'Break loop' },

    // Layout
    { label: '@extends', insertText: "@extends('${1:layout}')", doc: 'Extend a layout' },
    { label: '@section', insertText: "@section('${1:name}')\n\t$0\n@endsection", doc: 'Define a section' },
    { label: '@yield', insertText: "@yield('${1:name}')", doc: 'Yield a section' },
    { label: '@include', insertText: "@include('${1:view}')", doc: 'Include a view' },
    { label: '@includeIf', insertText: "@includeIf('${1:view}')", doc: 'Include view if it exists' },
    { label: '@includeWhen', insertText: "@includeWhen(${1:condition}, '${2:view}')", doc: 'Conditionally include view' },
    { label: '@each', insertText: "@each('${1:view}', ${2:\\$data}, '${3:item}')", doc: 'Render view for each item' },

    // Components
    { label: '@component', insertText: "@component('${1:component}')\n\t$0\n@endcomponent", doc: 'Render a component' },
    { label: '@slot', insertText: "@slot('${1:name}')\n\t$0\n@endslot", doc: 'Define a slot' },
    { label: '@props', insertText: "@props([${1:'prop' => 'default'}])", doc: 'Define component props' },

    // Stacks
    { label: '@push', insertText: "@push('${1:name}')\n\t$0\n@endpush", doc: 'Push to a stack' },
    { label: '@prepend', insertText: "@prepend('${1:name}')\n\t$0\n@endprepend", doc: 'Prepend to a stack' },
    { label: '@stack', insertText: "@stack('${1:name}')", doc: 'Render a stack' },

    // Auth
    { label: '@auth', insertText: '@auth\n\t$0\n@endauth', doc: 'Authenticated user block' },
    { label: '@guest', insertText: '@guest\n\t$0\n@endguest', doc: 'Guest user block' },
    { label: '@can', insertText: "@can('${1:ability}')\n\t$0\n@endcan", doc: 'Authorization check' },
    { label: '@cannot', insertText: "@cannot('${1:ability}')\n\t$0\n@endcannot", doc: 'Cannot authorization check' },

    // Forms & CSRF
    { label: '@csrf', insertText: '@csrf', doc: 'CSRF token field' },
    { label: '@method', insertText: "@method('${1|PUT,PATCH,DELETE|}')", doc: 'HTTP method spoofing' },
    { label: '@error', insertText: "@error('${1:field}')\n\t$0\n@enderror", doc: 'Validation error block' },
    { label: '@old', insertText: "@old('${1:field}')", doc: 'Old form value' },

    // HTML Attributes (Laravel 9+)
    { label: '@class', insertText: "@class([${1:'class' => condition}])", doc: 'Conditional CSS classes' },
    { label: '@style', insertText: "@style([${1:'color: red' => condition}])", doc: 'Conditional inline styles' },
    { label: '@checked', insertText: '@checked(${1:condition})', doc: 'Checked attribute if true' },
    { label: '@selected', insertText: '@selected(${1:condition})', doc: 'Selected attribute if true' },
    { label: '@disabled', insertText: '@disabled(${1:condition})', doc: 'Disabled attribute if true' },
    { label: '@readonly', insertText: '@readonly(${1:condition})', doc: 'Readonly attribute if true' },
    { label: '@required', insertText: '@required(${1:condition})', doc: 'Required attribute if true' },

    // Livewire
    { label: '@livewire', insertText: "@livewire('${1:component}')", doc: 'Render Livewire component' },
    { label: '@livewireStyles', insertText: '@livewireStyles', doc: 'Livewire CSS assets' },
    { label: '@livewireScripts', insertText: '@livewireScripts', doc: 'Livewire JS assets' },

    // Components (modern syntax)
    { label: '@aware', insertText: "@aware(['${1:prop}'])", doc: 'Access parent component data' },
    { label: '@teleport', insertText: "@teleport('${1:selector}')\n\t$0\n@endteleport", doc: 'Teleport content to selector' },
    { label: '@fragment', insertText: "@fragment('${1:name}')\n\t$0\n@endfragment", doc: 'Define a fragment' },
    { label: '@persist', insertText: "@persist('${1:name}')\n\t$0\n@endpersist", doc: 'Persist across navigations' },

    // Session & Errors
    { label: '@session', insertText: "@session('${1:key}')\n\t$0\n@endsession", doc: 'Session data block' },

    // Other
    { label: '@php', insertText: '@php\n\t$0\n@endphp', doc: 'Raw PHP block' },
    { label: '@json', insertText: '@json(${1:\\$data})', doc: 'Output as JSON' },
    { label: '@js', insertText: '@js(${1:\\$data})', doc: 'Output as JavaScript' },
    { label: '@dd', insertText: '@dd(${1:\\$variable})', doc: 'Dump and die' },
    { label: '@dump', insertText: '@dump(${1:\\$variable})', doc: 'Dump variable' },
    { label: '@env', insertText: "@env('${1:production}')\n\t$0\n@endenv", doc: 'Environment check' },
    { label: '@production', insertText: '@production\n\t$0\n@endproduction', doc: 'Production environment check' },
    { label: '@once', insertText: '@once\n\t$0\n@endonce', doc: 'Render content only once' },
    { label: '@vite', insertText: "@vite('${1:resources/css/app.css}')", doc: 'Vite asset' },
    { label: '@viteReactRefresh', insertText: '@viteReactRefresh', doc: 'Vite React refresh' },
    { label: '@lang', insertText: "@lang('${1:messages.key}')", doc: 'Localization string' },
    { label: '@choice', insertText: "@choice('${1:messages.key}', ${2:\\$count})", doc: 'Pluralized localization' },
  ];

  monaco.languages.registerCompletionItemProvider('php', {
    triggerCharacters: ['@'],

    provideCompletionItems(model, position) {
      // Solo ofrecer Blade completions en archivos .blade.php
      if (!model.uri.path.includes('.blade.php')) {
        return { suggestions: [] };
      }

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };

      // Verificar que estamos después de un @
      const lineContent = model.getLineContent(position.lineNumber);
      const charBefore = lineContent[position.column - 2];
      if (charBefore !== '@' && !lineContent.substring(0, position.column - 1).match(/@\w*$/)) {
        return { suggestions: [] };
      }

      return {
        suggestions: bladeDirectives.map((d) => ({
          label: d.label,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: d.insertText,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: d.doc },
          range,
        })),
      };
    },
  });
}

// ┌──────────────────────────────────────────────────┐
// │  INICIALIZACIÓN                                  │
// └──────────────────────────────────────────────────┘

/**
 * Iniciar el LSP para un workspace.
 * Se llama cuando se abre una carpeta.
 */
async function startLsp(workspaceFolder) {
  const result = await window.api.lspStart(workspaceFolder);
  if (result.error) {
    console.warn('[LSP] Failed to start:', result.error);
    lspState.ready = false;
    return;
  }

  lspState.ready = true;
  console.log('[LSP] Intelephense ready');

  // Trackear archivos PHP que ya estén abiertos
  if (typeof state !== 'undefined' && state.openTabs) {
    for (const tab of state.openTabs) {
      if (tab.model && tab.language === 'php') {
        lspTrackModel(tab.model, 'php');
      }
    }
  }
}

/**
 * Detener el LSP.
 */
async function stopLsp() {
  lspState.ready = false;
  lspState.documentVersions.clear();
  for (const [uri, disposable] of lspState.changeListeners) {
    disposable.dispose();
  }
  lspState.changeListeners.clear();
  await window.api.lspStop();
}

// ┌──────────────────────────────────────────────────┐
// │  PHP SMART SNIPPETS — Contextuales por posición  │
// └──────────────────────────────────────────────────┘
function initPhpSmartSnippets() {
  const snippets = [
    // Métodos (dentro de una clase)
    {
      label: 'fn',
      detail: 'Public method',
      insertText: 'public function ${1:methodName}(${2}): ${3:void}\n{\n\t$0\n}',
      context: 'class',
    },
    {
      label: 'fnp',
      detail: 'Private method',
      insertText: 'private function ${1:methodName}(${2}): ${3:void}\n{\n\t$0\n}',
      context: 'class',
    },
    {
      label: 'fnr',
      detail: 'Protected method',
      insertText: 'protected function ${1:methodName}(${2}): ${3:void}\n{\n\t$0\n}',
      context: 'class',
    },
    {
      label: 'fns',
      detail: 'Public static method',
      insertText: 'public static function ${1:methodName}(${2}): ${3:void}\n{\n\t$0\n}',
      context: 'class',
    },
    {
      label: '__construct',
      detail: 'Constructor',
      insertText: 'public function __construct(\n\t${1}\n) {\n\t$0\n}',
      context: 'class',
    },
    {
      label: 'cpr',
      detail: 'Constructor with promoted properties',
      insertText: 'public function __construct(\n\tprivate readonly ${1:string} \\$${2:property},\n) {\n\t$0\n}',
      context: 'class',
    },
    {
      label: 'prop',
      detail: 'Property declaration',
      insertText: '${1|public,private,protected|} ${2:string} \\$${3:property};',
      context: 'class',
    },
    {
      label: 'propr',
      detail: 'Readonly property',
      insertText: '${1|public,private,protected|} readonly ${2:string} \\$${3:property};',
      context: 'class',
    },
    // Funciones (fuera de clase)
    {
      label: 'fn',
      detail: 'Function',
      insertText: 'function ${1:functionName}(${2}): ${3:void}\n{\n\t$0\n}',
      context: 'global',
    },
    // Estructuras generales
    {
      label: 'class',
      detail: 'Class definition',
      insertText: 'class ${1:ClassName}\n{\n\t$0\n}',
      context: 'global',
    },
    {
      label: 'interface',
      detail: 'Interface definition',
      insertText: 'interface ${1:InterfaceName}\n{\n\t$0\n}',
      context: 'global',
    },
    {
      label: 'trait',
      detail: 'Trait definition',
      insertText: 'trait ${1:TraitName}\n{\n\t$0\n}',
      context: 'global',
    },
    {
      label: 'enum',
      detail: 'Enum definition (PHP 8.1+)',
      insertText: 'enum ${1:EnumName}${2:: string}\n{\n\tcase ${3:Value} = ${4:\'value\'};\n}',
      context: 'global',
    },
    {
      label: 'test',
      detail: 'PHPUnit test method',
      insertText: 'public function test_${1:it_does_something}(): void\n{\n\t$0\n}',
      context: 'class',
    },
    {
      label: 'testa',
      detail: 'PHPUnit test method with @test',
      insertText: '/** @test */\npublic function ${1:it_does_something}(): void\n{\n\t$0\n}',
      context: 'class',
    },
  ];

  /**
   * Detectar si el cursor está dentro de una clase/trait/interface.
   * Recorre las líneas hacia arriba buscando class/trait/interface,
   * contando llaves para determinar si estamos adentro.
   */
  function detectContext(model, position) {
    let braceDepth = 0;
    for (let i = position.lineNumber - 1; i >= 1; i--) {
      const line = model.getLineContent(i);
      for (let j = line.length - 1; j >= 0; j--) {
        if (line[j] === '}') braceDepth++;
        if (line[j] === '{') braceDepth--;
      }
      if (braceDepth < 0) {
        // Estamos dentro de un bloque — verificar si es clase
        if (line.match(/^\s*(?:abstract\s+|final\s+)?(?:class|trait|interface|enum)\s+\w+/)) {
          return 'class';
        }
      }
    }
    return 'global';
  }

  monaco.languages.registerCompletionItemProvider('php', {
    provideCompletionItems(model, position) {
      // No ofrecer en archivos .blade.php
      if (model.uri.path.includes('.blade.php')) {
        return { suggestions: [] };
      }

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      };

      const context = detectContext(model, position);

      return {
        suggestions: snippets
          .filter((s) => s.context === context)
          .map((s) => ({
            label: s.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: s.detail,
            range,
            sortText: '0' + s.label, // Priorizar sobre otros
          })),
      };
    },
  });
}

// Registrar los providers de Monaco una sola vez
initLspProviders();
initBladeCompletions();
initPhpSmartSnippets();
