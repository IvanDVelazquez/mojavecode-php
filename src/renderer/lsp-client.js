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

/**
 * Convierte additionalTextEdits del LSP (auto-imports) a formato Monaco.
 * El LSP manda edits como { range, newText } — Monaco espera { range, text }
 * con posiciones 1-based.
 */
function _mapAdditionalEdits(edits) {
  if (!edits || !Array.isArray(edits) || edits.length === 0) return undefined;
  return edits.map((e) => ({
    range: lspToMonacoRange(e.range),
    text: e.newText,
  }));
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
              additionalTextEdits: _mapAdditionalEdits(item.additionalTextEdits),
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
        // Auto-import: el LSP puede devolver additionalTextEdits en resolve
        if (resolved?.additionalTextEdits) {
          item.additionalTextEdits = _mapAdditionalEdits(resolved.additionalTextEdits);
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

  // ── RENAME SYMBOL (F2) ──
  //
  // Usa prepareRename para validar que el símbolo es renombrable,
  // luego textDocument/rename para obtener los WorkspaceEdits.
  // Antes de aplicar, muestra un panel de preview con la lista de
  // archivos y ocurrencias que serán afectados.
  monaco.languages.registerRenameProvider('php', {
    // Validar que la posición es renombrable y devolver el rango del símbolo.
    // Si prepareRename no está soportado o falla, fallback a la palabra
    // bajo el cursor — dejamos que textDocument/rename decida si es válido.
    async resolveRenameLocation(model, position) {
      if (!lspState.ready) return null;

      // Intentar prepareRename primero
      try {
        const response = await window.api.lspRequest('textDocument/prepareRename', {
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
        });

        if (response) {
          const range = response.range ? lspToMonacoRange(response.range) : lspToMonacoRange(response);
          const text = response.placeholder || model.getValueInRange(range);
          return { range, text };
        }
      } catch {
        // prepareRename no soportado o falló — fallback abajo
      }

      // Fallback: usar la palabra bajo el cursor
      const wordInfo = model.getWordAtPosition(position);
      if (!wordInfo) return { text: '', range: new monaco.Range(1,1,1,1), rejectReason: 'No symbol at cursor' };

      return {
        text: wordInfo.word,
        range: new monaco.Range(
          position.lineNumber, wordInfo.startColumn,
          position.lineNumber, wordInfo.endColumn
        ),
      };
    },

    // Ejecutar el rename y devolver los edits agrupados por archivo
    async provideRenameEdits(model, position, newName) {
      if (!lspState.ready) return null;

      try {
        const response = await window.api.lspRequest('textDocument/rename', {
          textDocument: { uri: model.uri.toString() },
          position: monacoToLspPosition(position),
          newName,
        });

        if (!response || !response.changes) return null;

        // Convertir LSP WorkspaceEdit a Monaco WorkspaceEdit
        const edits = [];
        let totalEdits = 0;
        let fileCount = 0;

        for (const [uri, textEdits] of Object.entries(response.changes)) {
          fileCount++;
          const resource = monaco.Uri.parse(uri);

          // Pre-crear modelos para archivos no abiertos (igual que go-to-definition)
          if (!monaco.editor.getModel(resource)) {
            try {
              const filePath = resource.path;
              const fileResult = await window.api.readFile(filePath);
              if (!fileResult.error) {
                const ext = filePath.split('.').pop();
                const lang = getMonacoLanguage(ext);
                monaco.editor.createModel(fileResult.content, lang, resource);
              }
            } catch { /* silencioso */ }
          }

          for (const edit of textEdits) {
            totalEdits++;
            edits.push({
              resource,
              textEdit: {
                range: lspToMonacoRange(edit.range),
                text: edit.newText,
              },
              versionId: undefined,
            });
          }
        }

        // Mostrar info del refactor en el status bar
        if (typeof showRenameInfo === 'function') {
          showRenameInfo(fileCount, totalEdits, newName);
        }

        return { edits };
      } catch (err) {
        console.error('[LSP] Rename error:', err);
        return null;
      }
    },
  });

  // ── CODE ACTIONS (auto-import, quick fixes) ──
  //
  // Cuando el cursor está sobre un error/warning, Monaco muestra el
  // lightbulb (💡). Al hacer click o Cmd+., se piden code actions al
  // LSP que pueden incluir auto-imports, quick fixes, refactors, etc.
  monaco.languages.registerCodeActionProvider('php', {
    async provideCodeActions(model, range, context) {
      if (!lspState.ready) return { actions: [], dispose: () => {} };

      const uri = model.uri.toString();

      // Convertir markers de Monaco a diagnostics LSP para mandar al servidor
      const diagnostics = (context.markers || []).map((m) => ({
        range: {
          start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
          end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
        },
        message: m.message,
        severity: m.severity === monaco.MarkerSeverity.Error ? 1
          : m.severity === monaco.MarkerSeverity.Warning ? 2
          : m.severity === monaco.MarkerSeverity.Info ? 3 : 4,
        code: m.code,
        source: m.source,
      }));

      try {
        const result = await window.api.lspRequest('textDocument/codeAction', {
          textDocument: { uri },
          range: {
            start: monacoToLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: monacoToLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
          context: { diagnostics },
        });

        if (!result || !Array.isArray(result)) return { actions: [], dispose: () => {} };

        const actions = result.map((action) => _lspCodeActionToMonaco(action, model, 'lsp')).filter(Boolean);
        return { actions, dispose: () => {} };
      } catch { return { actions: [], dispose: () => {} }; }
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
// │  CODE ACTION HELPERS                             │
// │  Convierte LSP CodeActions a formato Monaco.     │
// │  Soporta workspace edits (auto-import) y        │
// │  command-based actions.                          │
// └──────────────────────────────────────────────────┘

/**
 * Convierte un LSP CodeAction a un Monaco CodeAction.
 * Soporta WorkspaceEdit (changes y documentChanges) para auto-imports.
 *
 * @param {object} action - LSP CodeAction
 * @param {object} model - Monaco model activo
 * @param {string} lspChannel - 'lsp' o 'tsLsp' para resolver actions lazy
 * @returns {object|null} Monaco CodeAction
 */
function _lspCodeActionToMonaco(action, model, lspChannel) {
  if (!action) return null;

  // Si es un Command (sin edit), solo tiene title
  if (!action.edit && action.command) {
    return {
      title: action.title,
      kind: action.kind || 'quickfix',
      command: {
        id: action.command.command,
        title: action.command.title || action.title,
        arguments: action.command.arguments,
      },
    };
  }

  // WorkspaceEdit → Monaco edits
  const monacoEdits = [];

  if (action.edit) {
    // Formato "changes": { uri: TextEdit[] }
    if (action.edit.changes) {
      for (const [uri, textEdits] of Object.entries(action.edit.changes)) {
        const resource = monaco.Uri.parse(uri);

        // Pre-crear modelos para archivos no abiertos
        if (!monaco.editor.getModel(resource)) {
          try {
            // No bloquear — el edit se aplica al model que crearemos
            window.api.readFile(resource.path).then((fileResult) => {
              if (!fileResult.error && !monaco.editor.getModel(resource)) {
                const ext = resource.path.split('.').pop();
                monaco.editor.createModel(fileResult.content, getMonacoLanguage(ext), resource);
              }
            });
          } catch { /* silent */ }
        }

        for (const edit of textEdits) {
          monacoEdits.push({
            resource,
            textEdit: {
              range: lspToMonacoRange(edit.range),
              text: edit.newText,
            },
          });
        }
      }
    }

    // Formato "documentChanges": TextDocumentEdit[]
    if (action.edit.documentChanges) {
      for (const docChange of action.edit.documentChanges) {
        if (!docChange.textDocument || !docChange.edits) continue;
        const resource = monaco.Uri.parse(docChange.textDocument.uri);
        for (const edit of docChange.edits) {
          monacoEdits.push({
            resource,
            textEdit: {
              range: lspToMonacoRange(edit.range),
              text: edit.newText,
            },
          });
        }
      }
    }
  }

  if (monacoEdits.length === 0 && !action.command) return null;

  return {
    title: action.title,
    kind: action.kind || 'quickfix',
    edit: monacoEdits.length > 0 ? { edits: monacoEdits } : undefined,
    isPreferred: action.isPreferred || false,
  };
}

// ┌──────────────────────────────────────────────────┐
// │  HTML TAG COMPLETIONS — Tags y atributos HTML5  │
// │  Para archivos .html y .blade.php               │
// └──────────────────────────────────────────────────┘
function initHtmlCompletions() {
  // Tags con sus atributos más comunes y si son self-closing
  const tags = [
    // Document
    { tag: 'html', attrs: 'lang="${1:en}"', body: true },
    { tag: 'head', body: true }, { tag: 'body', body: true },
    { tag: 'title', body: true }, { tag: 'meta', attrs: '${1|charset,name,content,http-equiv|}="${2}"' },
    { tag: 'link', attrs: 'rel="${1:stylesheet}" href="${2}"' },
    { tag: 'script', attrs: '${1:src="${2}"}', body: true },
    { tag: 'style', body: true }, { tag: 'base', attrs: 'href="${1}"' },
    // Sections
    { tag: 'div', body: true }, { tag: 'span', body: true },
    { tag: 'section', body: true }, { tag: 'article', body: true },
    { tag: 'aside', body: true }, { tag: 'header', body: true },
    { tag: 'footer', body: true }, { tag: 'nav', body: true },
    { tag: 'main', body: true },
    // Headings
    { tag: 'h1', body: true }, { tag: 'h2', body: true }, { tag: 'h3', body: true },
    { tag: 'h4', body: true }, { tag: 'h5', body: true }, { tag: 'h6', body: true },
    // Text
    { tag: 'p', body: true }, { tag: 'a', attrs: 'href="${1:#}"', body: true },
    { tag: 'strong', body: true }, { tag: 'em', body: true },
    { tag: 'small', body: true }, { tag: 'br' }, { tag: 'hr' },
    { tag: 'pre', body: true }, { tag: 'code', body: true },
    { tag: 'blockquote', body: true },
    // Lists
    { tag: 'ul', body: true }, { tag: 'ol', body: true }, { tag: 'li', body: true },
    { tag: 'dl', body: true }, { tag: 'dt', body: true }, { tag: 'dd', body: true },
    // Table
    { tag: 'table', body: true }, { tag: 'thead', body: true },
    { tag: 'tbody', body: true }, { tag: 'tfoot', body: true },
    { tag: 'tr', body: true }, { tag: 'th', body: true }, { tag: 'td', body: true },
    // Forms
    { tag: 'form', attrs: 'action="${1}" method="${2|GET,POST|}"', body: true },
    { tag: 'input', attrs: 'type="${1|text,password,email,number,checkbox,radio,file,hidden,submit,date,tel,url|}" name="${2}"' },
    { tag: 'textarea', attrs: 'name="${1}" rows="${2:4}"', body: true },
    { tag: 'select', attrs: 'name="${1}"', body: true },
    { tag: 'option', attrs: 'value="${1}"', body: true },
    { tag: 'button', attrs: 'type="${1|submit,button,reset|}"', body: true },
    { tag: 'label', attrs: 'for="${1}"', body: true },
    { tag: 'fieldset', body: true }, { tag: 'legend', body: true },
    // Media
    { tag: 'img', attrs: 'src="${1}" alt="${2}"' },
    { tag: 'video', attrs: 'src="${1}" controls', body: true },
    { tag: 'audio', attrs: 'src="${1}" controls', body: true },
    { tag: 'source', attrs: 'src="${1}" type="${2}"' },
    { tag: 'picture', body: true }, { tag: 'canvas', body: true },
    { tag: 'svg', attrs: 'viewBox="${1:0 0 24 24}"', body: true },
    { tag: 'iframe', attrs: 'src="${1}" width="${2}" height="${3}"' },
    // Interactive
    { tag: 'details', body: true }, { tag: 'summary', body: true },
    { tag: 'dialog', body: true },
    // Other
    { tag: 'template', body: true }, { tag: 'slot', body: true },
    { tag: 'figure', body: true }, { tag: 'figcaption', body: true },
    { tag: 'mark', body: true }, { tag: 'time', body: true },
    { tag: 'progress', attrs: 'value="${1}" max="${2:100}"' },
    { tag: 'output', body: true },
  ];

  // Atributos globales HTML
  const globalAttrs = [
    { attr: 'class', insert: 'class="${1}"' },
    { attr: 'id', insert: 'id="${1}"' },
    { attr: 'style', insert: 'style="${1}"' },
    { attr: 'title', insert: 'title="${1}"' },
    { attr: 'hidden', insert: 'hidden' },
    { attr: 'data-', insert: 'data-${1}="${2}"' },
    { attr: 'aria-label', insert: 'aria-label="${1}"' },
    { attr: 'aria-hidden', insert: 'aria-hidden="${1|true,false|}"' },
    { attr: 'role', insert: 'role="${1}"' },
    { attr: 'tabindex', insert: 'tabindex="${1:0}"' },
    // Events
    { attr: 'onclick', insert: 'onclick="${1}"' },
    { attr: 'onchange', insert: 'onchange="${1}"' },
    { attr: 'onsubmit', insert: 'onsubmit="${1}"' },
    { attr: 'onkeydown', insert: 'onkeydown="${1}"' },
    // Alpine.js (common in Laravel)
    { attr: 'x-data', insert: 'x-data="${1:{}}"' },
    { attr: 'x-show', insert: 'x-show="${1}"' },
    { attr: 'x-if', insert: 'x-if="${1}"' },
    { attr: 'x-for', insert: 'x-for="${1:item} in ${2:items}"' },
    { attr: 'x-on:', insert: 'x-on:${1:click}="${2}"' },
    { attr: 'x-bind:', insert: 'x-bind:${1:class}="${2}"' },
    { attr: 'x-model', insert: 'x-model="${1}"' },
    { attr: 'x-text', insert: 'x-text="${1}"' },
    // Livewire
    { attr: 'wire:model', insert: 'wire:model="${1}"' },
    { attr: 'wire:click', insert: 'wire:click="${1}"' },
    { attr: 'wire:submit', insert: 'wire:submit="${1}"' },
    { attr: 'wire:loading', insert: 'wire:loading' },
  ];

  // Emmet-style snippets
  const emmetSnippets = [
    { label: '!', insert: '<!DOCTYPE html>\n<html lang="${1:en}">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>${2:Document}</title>\n</head>\n<body>\n\t$0\n</body>\n</html>', doc: 'HTML5 boilerplate' },
    { label: 'div.class', insert: '<div class="${1}">\n\t$0\n</div>', doc: 'div with class' },
    { label: 'div#id', insert: '<div id="${1}">\n\t$0\n</div>', doc: 'div with id' },
    { label: 'ul>li', insert: '<ul>\n\t<li>$0</li>\n</ul>', doc: 'Unordered list with item' },
    { label: 'ol>li', insert: '<ol>\n\t<li>$0</li>\n</ol>', doc: 'Ordered list with item' },
    { label: 'table>tr>td', insert: '<table>\n\t<tr>\n\t\t<td>$0</td>\n\t</tr>\n</table>', doc: 'Table with row and cell' },
    { label: 'a:link', insert: '<a href="${1:#}">${2:link}</a>', doc: 'Anchor link' },
    { label: 'a:mail', insert: '<a href="mailto:${1}">${2:email}</a>', doc: 'Email link' },
    { label: 'img:src', insert: '<img src="${1}" alt="${2}">', doc: 'Image' },
    { label: 'input:text', insert: '<input type="text" name="${1}" placeholder="${2}">', doc: 'Text input' },
    { label: 'input:email', insert: '<input type="email" name="${1}" placeholder="${2}">', doc: 'Email input' },
    { label: 'input:password', insert: '<input type="password" name="${1}">', doc: 'Password input' },
    { label: 'input:checkbox', insert: '<input type="checkbox" name="${1}" id="${2}">', doc: 'Checkbox' },
    { label: 'input:radio', insert: '<input type="radio" name="${1}" value="${2}">', doc: 'Radio button' },
    { label: 'input:hidden', insert: '<input type="hidden" name="${1}" value="${2}">', doc: 'Hidden input' },
    { label: 'input:submit', insert: '<input type="submit" value="${1:Submit}">', doc: 'Submit button' },
    { label: 'btn', insert: '<button type="${1|button,submit|}">${2:Click}</button>', doc: 'Button' },
    { label: 'link:css', insert: '<link rel="stylesheet" href="${1:styles.css}">', doc: 'CSS link' },
    { label: 'script:src', insert: '<script src="${1}"></script>', doc: 'Script tag with src' },
    { label: 'meta:vp', insert: '<meta name="viewport" content="width=device-width, initial-scale=1.0">', doc: 'Viewport meta' },
  ];

  for (const lang of ['html', 'php']) {
    // Tag completions — trigger on <
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['<'],
      provideCompletionItems(model, position) {
        // En PHP, solo ofrecer HTML completions en archivos .blade.php o .html
        if (lang === 'php' && !model.uri.path.includes('.blade.php')) {
          return { suggestions: [] };
        }

        const line = model.getLineContent(position.lineNumber);
        const before = line.substring(0, position.column - 1);
        // Solo sugerir tags después de < (no dentro de atributos)
        if (!before.match(/<\w*$/)) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, startColumn: word.startColumn,
          endLineNumber: position.lineNumber, endColumn: word.endColumn,
        };

        return {
          suggestions: tags.map((t) => {
            const insert = t.body
              ? (t.attrs ? `${t.tag} ${t.attrs}>\n\t$0\n</${t.tag}>` : `${t.tag}>\n\t$0\n</${t.tag}>`)
              : (t.attrs ? `${t.tag} ${t.attrs}>` : `${t.tag}>`);
            return {
              label: t.tag,
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: insert,
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              detail: t.body ? `<${t.tag}>...</${t.tag}>` : `<${t.tag}>`,
              range,
              sortText: '0' + t.tag,
            };
          }),
        };
      },
    });

    // Attribute completions — trigger on space inside a tag
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: [' '],
      provideCompletionItems(model, position) {
        if (lang === 'php' && !model.uri.path.includes('.blade.php')) {
          return { suggestions: [] };
        }

        const line = model.getLineContent(position.lineNumber);
        const before = line.substring(0, position.column - 1);
        // Verificar que estamos dentro de un tag abierto (hay < sin > cerrado)
        const lastOpen = before.lastIndexOf('<');
        const lastClose = before.lastIndexOf('>');
        if (lastOpen === -1 || lastClose > lastOpen) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, startColumn: word.startColumn,
          endLineNumber: position.lineNumber, endColumn: word.endColumn,
        };

        return {
          suggestions: globalAttrs.map((a) => ({
            label: a.attr,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: a.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        };
      },
    });

    // Emmet-style snippets
    monaco.languages.registerCompletionItemProvider(lang, {
      provideCompletionItems(model, position) {
        if (lang === 'php' && !model.uri.path.includes('.blade.php')) {
          return { suggestions: [] };
        }

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber, startColumn: word.startColumn,
          endLineNumber: position.lineNumber, endColumn: word.endColumn,
        };

        return {
          suggestions: emmetSnippets.map((s) => ({
            label: s.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: s.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: s.doc },
            range,
            sortText: '1' + s.label,
          })),
        };
      },
    });

    // Auto-close tags — trigger on /
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['/'],
      provideCompletionItems(model, position) {
        if (lang === 'php' && !model.uri.path.includes('.blade.php')) {
          return { suggestions: [] };
        }

        const line = model.getLineContent(position.lineNumber);
        const before = line.substring(0, position.column - 1);
        // Detectar </ para auto-cerrar el tag más reciente
        if (!before.endsWith('</')) return { suggestions: [] };

        // Buscar el último tag abierto sin cerrar
        const textBefore = model.getValueInRange({
          startLineNumber: Math.max(1, position.lineNumber - 50),
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const openTags = [];
        const selfClosing = new Set(['br','hr','img','input','meta','link','source','base','area','col','embed','track','wbr']);
        const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9-]*)/g;
        let m;
        while ((m = tagRegex.exec(textBefore)) !== null) {
          if (m[0].startsWith('</')) {
            // Closing tag — pop matching open
            const idx = openTags.lastIndexOf(m[1].toLowerCase());
            if (idx !== -1) openTags.splice(idx, 1);
          } else if (!selfClosing.has(m[1].toLowerCase())) {
            openTags.push(m[1].toLowerCase());
          }
        }

        if (openTags.length === 0) return { suggestions: [] };

        const lastTag = openTags[openTags.length - 1];
        const range = {
          startLineNumber: position.lineNumber, startColumn: position.column,
          endLineNumber: position.lineNumber, endColumn: position.column,
        };

        return {
          suggestions: [{
            label: `/${lastTag}>`,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: `${lastTag}>`,
            range,
            sortText: '0',
            preselect: true,
          }],
        };
      },
    });
  }
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
 * Detener el LSP de PHP.
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

/**
 * Iniciar el TS LSP para un workspace.
 * Se llama cuando se abre una carpeta que tiene archivos TS/JS.
 */
async function startTsLsp(workspaceFolder) {
  const result = await window.api.tsLspStart(workspaceFolder);
  if (result.error) {
    console.warn('[tsLsp] Failed to start:', result.error);
    tsLspState.ready = false;
    return;
  }

  tsLspState.ready = true;
  console.log('[tsLsp] TypeScript language server ready');

  // Trackear archivos TS/JS que ya estén abiertos
  if (typeof state !== 'undefined' && state.openTabs) {
    for (const tab of state.openTabs) {
      if (tab.model && isTsFile(tab.path)) {
        tsLspTrackModel(tab.model);
      }
    }
  }
}

/**
 * Detener el TS LSP.
 */
async function stopTsLsp() {
  tsLspState.ready = false;
  tsLspState.documentVersions.clear();
  for (const [uri, disposable] of tsLspState.changeListeners) {
    disposable.dispose();
  }
  tsLspState.changeListeners.clear();
  await window.api.tsLspStop();
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

// ┌──────────────────────────────────────────────────┐
// │  TS/JS LSP CLIENT — TypeScript, JavaScript,     │
// │  React (JSX/TSX). Segundo servidor LSP que      │
// │  convive con Intelephense, usando canal IPC     │
// │  separado (tsLsp:*).                            │
// └──────────────────────────────────────────────────┘

const tsLspState = {
  ready: false,
  documentVersions: new Map(),
  changeListeners: new Map(),
};

// Monaco solo reconoce 'typescript' y 'javascript' como lenguajes.
// JSX/TSX usan esos mismos lenguajes para tokenización, pero el TS LSP
// recibe el languageId correcto (typescriptreact/javascriptreact) via tsLanguageId().
const TS_LANGUAGES = ['typescript', 'javascript'];
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts']);

/**
 * Mapea extensión de archivo al languageId que espera el TS LSP.
 */
function tsLanguageId(filePath) {
  if (filePath.endsWith('.tsx')) return 'typescriptreact';
  if (filePath.endsWith('.jsx')) return 'javascriptreact';
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) return 'typescript';
  return 'javascript';
}

function isTsFile(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return TS_EXTENSIONS.has(ext);
}

// ── TS Document Sync ─────────────────────────────────────────
// Misma lógica que el PHP sync pero usando el canal tsLsp:*.
// Notifica al typescript-language-server de aperturas, cambios,
// cierres y guardados de archivos TS/JS/JSX/TSX.

/** Notifica al TS LSP que un archivo fue abierto. */
function tsLspDidOpen(uri, languageId, content) {
  if (!tsLspState.ready) return;
  tsLspState.documentVersions.set(uri, 1);
  window.api.tsLspNotify('textDocument/didOpen', {
    textDocument: { uri, languageId, version: 1, text: content },
  });
}

/** Notifica al TS LSP que el contenido de un archivo cambió. */
function tsLspDidChange(uri, content) {
  if (!tsLspState.ready) return;
  const version = (tsLspState.documentVersions.get(uri) || 0) + 1;
  tsLspState.documentVersions.set(uri, version);
  window.api.tsLspNotify('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text: content }],
  });
}

/** Notifica al TS LSP que un archivo fue cerrado. Limpia markers. */
function tsLspDidClose(uri) {
  if (!tsLspState.ready) return;
  tsLspState.documentVersions.delete(uri);
  window.api.tsLspNotify('textDocument/didClose', { textDocument: { uri } });
  const disposable = tsLspState.changeListeners.get(uri);
  if (disposable) { disposable.dispose(); tsLspState.changeListeners.delete(uri); }
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (model) monaco.editor.setModelMarkers(model, 'typescript', []);
}

/** Notifica al TS LSP que un archivo fue guardado. */
function tsLspDidSave(uri, content) {
  if (!tsLspState.ready) return;
  window.api.tsLspNotify('textDocument/didSave', { textDocument: { uri }, text: content });
}

/**
 * Registrar un modelo TS/JS para sync con el TS LSP.
 */
function tsLspTrackModel(model) {
  if (!tsLspState.ready) return;
  const filePath = model.uri.path;
  if (!isTsFile(filePath)) return;

  const uri = model.uri.toString();
  tsLspDidOpen(uri, tsLanguageId(filePath), model.getValue());

  const disposable = model.onDidChangeContent(() => {
    tsLspDidChange(uri, model.getValue());
  });
  tsLspState.changeListeners.set(uri, disposable);
}

function tsLspUntrackModel(model) {
  if (!model) return;
  const uri = model.uri.toString();
  if (tsLspState.documentVersions.has(uri)) {
    tsLspDidClose(uri);
  }
}

/**
 * Registra providers de Monaco para TypeScript/JavaScript/React.
 * Misma estructura que los PHP providers pero usando tsLsp IPC.
 */
function initTsLspProviders() {
  for (const lang of TS_LANGUAGES) {
    // ── COMPLETION ──
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['.', '/', '<', '"', "'", '`', '@'],
      async provideCompletionItems(model, position) {
        if (!tsLspState.ready) return { suggestions: [] };
        try {
          const response = await window.api.tsLspRequest('textDocument/completion', {
            textDocument: { uri: model.uri.toString() },
            position: monacoToLspPosition(position),
          });
          if (!response) return { suggestions: [] };
          const items = response.items || response;
          if (!Array.isArray(items)) return { suggestions: [] };
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber, startColumn: word.startColumn,
            endLineNumber: position.lineNumber, endColumn: word.endColumn,
          };
          return {
            suggestions: items.map((item) => ({
              label: item.label,
              kind: mapCompletionKind(item.kind),
              insertText: item.textEdit?.newText || item.insertText || item.label,
              insertTextRules: item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              detail: item.detail || '',
              documentation: item.documentation
                ? { value: item.documentation.value || item.documentation } : undefined,
              sortText: item.sortText,
              filterText: item.filterText,
              range: item.textEdit?.range ? lspToMonacoRange(item.textEdit.range) : range,
              additionalTextEdits: _mapAdditionalEdits(item.additionalTextEdits),
              _lspItem: item,
            })),
          };
        } catch { return { suggestions: [] }; }
      },
      async resolveCompletionItem(item) {
        if (!tsLspState.ready || !item._lspItem) return item;
        try {
          const resolved = await window.api.tsLspRequest('completionItem/resolve', item._lspItem);
          if (resolved?.documentation) item.documentation = { value: resolved.documentation.value || String(resolved.documentation) };
          if (resolved?.detail) item.detail = resolved.detail;
          if (resolved?.additionalTextEdits) item.additionalTextEdits = _mapAdditionalEdits(resolved.additionalTextEdits);
        } catch { /* resolve is optional */ }
        return item;
      },
    });

    // ── HOVER ──
    monaco.languages.registerHoverProvider(lang, {
      async provideHover(model, position) {
        if (!tsLspState.ready) return null;
        try {
          const response = await window.api.tsLspRequest('textDocument/hover', {
            textDocument: { uri: model.uri.toString() },
            position: monacoToLspPosition(position),
          });
          if (!response || !response.contents) return null;
          let contents;
          if (typeof response.contents === 'string') contents = [{ value: response.contents }];
          else if (response.contents.value) contents = [{ value: response.contents.value }];
          else if (Array.isArray(response.contents)) contents = response.contents.map(c => typeof c === 'string' ? { value: c } : { value: c.value || String(c) });
          else contents = [{ value: String(response.contents) }];
          return { contents, range: response.range ? lspToMonacoRange(response.range) : undefined };
        } catch { return null; }
      },
    });

    // ── GO TO DEFINITION ──
    monaco.languages.registerDefinitionProvider(lang, {
      async provideDefinition(model, position) {
        if (!tsLspState.ready) return null;
        try {
          const response = await window.api.tsLspRequest('textDocument/definition', {
            textDocument: { uri: model.uri.toString() },
            position: monacoToLspPosition(position),
          });
          if (!response) return null;
          const locations = Array.isArray(response) ? response : [response];
          for (const loc of locations) {
            const locUri = monaco.Uri.parse(loc.uri);
            if (!monaco.editor.getModel(locUri)) {
              try {
                const fileResult = await window.api.readFile(locUri.path);
                if (!fileResult.error) {
                  const ext = locUri.path.split('.').pop();
                  const langId = getMonacoLanguage(ext);
                  monaco.editor.createModel(fileResult.content, langId, locUri);
                }
              } catch { /* silent */ }
            }
          }
          return locations.map(loc => ({ uri: monaco.Uri.parse(loc.uri), range: lspToMonacoRange(loc.range) }));
        } catch { return null; }
      },
    });

    // ── SIGNATURE HELP ──
    monaco.languages.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ',', '<'],
      async provideSignatureHelp(model, position) {
        if (!tsLspState.ready) return null;
        try {
          const response = await window.api.tsLspRequest('textDocument/signatureHelp', {
            textDocument: { uri: model.uri.toString() },
            position: monacoToLspPosition(position),
          });
          if (!response || !response.signatures?.length) return null;
          return {
            value: {
              signatures: response.signatures.map(sig => ({
                label: sig.label,
                documentation: sig.documentation ? { value: sig.documentation.value || sig.documentation } : undefined,
                parameters: (sig.parameters || []).map(p => ({
                  label: p.label,
                  documentation: p.documentation ? { value: p.documentation.value || p.documentation } : undefined,
                })),
              })),
              activeSignature: response.activeSignature || 0,
              activeParameter: response.activeParameter || 0,
            },
            dispose: () => {},
          };
        } catch { return null; }
      },
    });

    // ── RENAME ──
    monaco.languages.registerRenameProvider(lang, {
      async resolveRenameLocation(model, position) {
        if (!tsLspState.ready) return null;
        try {
          const response = await window.api.tsLspRequest('textDocument/prepareRename', {
            textDocument: { uri: model.uri.toString() },
            position: monacoToLspPosition(position),
          });
          if (response) {
            const range = response.range ? lspToMonacoRange(response.range) : lspToMonacoRange(response);
            return { range, text: response.placeholder || model.getValueInRange(range) };
          }
        } catch { /* fallback */ }
        const wordInfo = model.getWordAtPosition(position);
        if (!wordInfo) return { text: '', range: new monaco.Range(1,1,1,1), rejectReason: 'No symbol at cursor' };
        return { text: wordInfo.word, range: new monaco.Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn) };
      },
      async provideRenameEdits(model, position, newName) {
        if (!tsLspState.ready) return null;
        try {
          const response = await window.api.tsLspRequest('textDocument/rename', {
            textDocument: { uri: model.uri.toString() },
            position: monacoToLspPosition(position),
            newName,
          });
          if (!response || !response.changes) return null;
          const edits = [];
          let totalEdits = 0, fileCount = 0;
          for (const [uri, textEdits] of Object.entries(response.changes)) {
            fileCount++;
            const resource = monaco.Uri.parse(uri);
            if (!monaco.editor.getModel(resource)) {
              try {
                const fileResult = await window.api.readFile(resource.path);
                if (!fileResult.error) {
                  const ext = resource.path.split('.').pop();
                  monaco.editor.createModel(fileResult.content, getMonacoLanguage(ext), resource);
                }
              } catch { /* silent */ }
            }
            for (const edit of textEdits) {
              totalEdits++;
              edits.push({ resource, textEdit: { range: lspToMonacoRange(edit.range), text: edit.newText } });
            }
          }
          if (typeof showRenameInfo === 'function') showRenameInfo(fileCount, totalEdits, newName);
          return { edits };
        } catch { return null; }
      },
    });
  }

  // ── TS CODE ACTIONS (auto-import, quick fixes) ──
  for (const lang of TS_LANGUAGES) {
    monaco.languages.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, context) {
        if (!tsLspState.ready) return { actions: [], dispose: () => {} };

        const diagnostics = (context.markers || []).map((m) => ({
          range: {
            start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
            end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
          },
          message: m.message,
          severity: m.severity === monaco.MarkerSeverity.Error ? 1
            : m.severity === monaco.MarkerSeverity.Warning ? 2
            : m.severity === monaco.MarkerSeverity.Info ? 3 : 4,
          code: m.code,
          source: m.source,
        }));

        try {
          const result = await window.api.tsLspRequest('textDocument/codeAction', {
            textDocument: { uri: model.uri.toString() },
            range: {
              start: monacoToLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
              end: monacoToLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
            },
            context: { diagnostics },
          });

          if (!result || !Array.isArray(result)) return { actions: [], dispose: () => {} };
          const actions = result.map((a) => _lspCodeActionToMonaco(a, model, 'tsLsp')).filter(Boolean);
          return { actions, dispose: () => {} };
        } catch { return { actions: [], dispose: () => {} }; }
      },
    });
  }

  // ── TS DIAGNOSTICS ──
  window.api.onTsLspNotification((message) => {
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params;
      const modelUri = monaco.Uri.parse(uri);
      const model = monaco.editor.getModel(modelUri);
      if (model) {
        const markers = diagnostics.map(d => ({
          severity: mapDiagnosticSeverity(d.severity),
          message: d.message,
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          source: d.source || 'typescript',
          code: d.code,
        }));
        monaco.editor.setModelMarkers(model, 'typescript', markers);
      }
    }
  });
}

// Registrar los providers de Monaco una sola vez
initLspProviders();
initHtmlCompletions();
initBladeCompletions();
initPhpSmartSnippets();
initTsLspProviders();
