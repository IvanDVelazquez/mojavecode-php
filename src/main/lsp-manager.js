/**
 * ══════════════════════════════════════════════════════════════
 * LSP MANAGER — Language Server Protocol para MojaveCode PHP
 * ══════════════════════════════════════════════════════════════
 *
 * Maneja el ciclo de vida del servidor LSP (Intelephense) y la
 * comunicación JSON-RPC sobre stdio.
 *
 * PROTOCOLO:
 * El LSP usa JSON-RPC 2.0 sobre stdio con framing HTTP-like:
 *   Content-Length: 123\r\n
 *   \r\n
 *   {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *
 * FLUJO:
 * 1. spawn node intelephense --stdio
 * 2. Enviar initialize request con capabilities
 * 3. Recibir initialize response
 * 4. Enviar initialized notification
 * 5. Ya está listo para recibir textDocument/* requests
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

class LspManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = Buffer.alloc(0);
    this.state = 'stopped'; // stopped | starting | ready
  }

  async start(workspaceFolder) {
    if (this.process) {
      this.stop();
    }

    this.state = 'starting';

    // Buscar intelephense en node_modules
    const intelephensePath = path.join(
      __dirname, '..', '..', 'node_modules', 'intelephense', 'lib', 'intelephense.js'
    );

    try {
      this.process = spawn(process.execPath, [intelephensePath, '--stdio'], {
        cwd: workspaceFolder,
        env: { ...process.env },
      });
    } catch (err) {
      this.state = 'stopped';
      return { error: err.message };
    }

    // Parsear stdout (JSON-RPC framing)
    this.process.stdout.on('data', (chunk) => {
      this._onData(chunk);
    });

    this.process.stderr.on('data', (data) => {
      console.error('[LSP stderr]', data.toString());
    });

    this.process.on('exit', (code) => {
      console.log('[LSP] Process exited with code', code);
      this.state = 'stopped';
      this.process = null;
      // Rechazar todas las requests pendientes
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error('LSP process exited'));
      }
      this.pendingRequests.clear();
    });

    this.process.on('error', (err) => {
      console.error('[LSP] Process error:', err.message);
      this.state = 'stopped';
    });

    // Enviar initialize
    try {
      const initResult = await this.sendRequest('initialize', {
        processId: process.pid,
        capabilities: {
          textDocument: {
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                resolveSupport: {
                  properties: ['documentation', 'detail', 'additionalTextEdits'],
                },
              },
            },
            hover: {
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {},
            signatureHelp: {
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext'],
              },
            },
            publishDiagnostics: {
              relatedInformation: true,
            },
            synchronization: {
              didSave: true,
              dynamicRegistration: false,
            },
          },
          workspace: {
            workspaceFolders: true,
          },
        },
        rootUri: `file://${workspaceFolder}`,
        workspaceFolders: [
          {
            uri: `file://${workspaceFolder}`,
            name: path.basename(workspaceFolder),
          },
        ],
        initializationOptions: {
          storagePath: path.join(os.tmpdir(), 'intelephense'),
          clearCache: false,
        },
      });

      // Enviar initialized notification
      this.sendNotification('initialized', {});
      this.state = 'ready';

      return { success: true, capabilities: initResult.capabilities };
    } catch (err) {
      this.stop();
      return { error: err.message };
    }
  }

  stop() {
    if (this.process) {
      try {
        this.sendNotification('shutdown', null);
        this.sendNotification('exit', null);
      } catch (e) {
        // Ignorar si ya cerró
      }
      setTimeout(() => {
        if (this.process) {
          this.process.kill();
          this.process = null;
        }
      }, 500);
    }
    this.state = 'stopped';
    this.buffer = Buffer.alloc(0);
    for (const [id, { reject }] of this.pendingRequests) {
      reject(new Error('LSP stopped'));
    }
    this.pendingRequests.clear();
  }

  sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.process) {
        return reject(new Error('LSP not running'));
      }

      const id = ++this.requestId;
      this.pendingRequests.set(id, { resolve, reject });

      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this._write(message);
    });
  }

  sendNotification(method, params) {
    if (!this.process) return;

    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    this._write(message);
  }

  _write(jsonString) {
    const content = Buffer.from(jsonString, 'utf-8');
    const header = `Content-Length: ${content.length}\r\n\r\n`;
    try {
      this.process.stdin.write(header);
      this.process.stdin.write(content);
    } catch (e) {
      console.error('[LSP] Write error:', e.message);
    }
  }

  /**
   * Parsear el stream de stdout con framing Content-Length.
   * Los datos pueden llegar fragmentados, así que acumulamos en un buffer.
   */
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      // Buscar el header "Content-Length: N\r\n\r\n"
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerStr = this.buffer.slice(0, headerEnd).toString('utf-8');
      const match = headerStr.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Header inválido, descartar
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      // ¿Tenemos suficientes bytes para el body completo?
      if (this.buffer.length < bodyStart + contentLength) {
        break; // Esperar más datos
      }

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength).toString('utf-8');
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body);
        this._handleMessage(message);
      } catch (e) {
        console.error('[LSP] JSON parse error:', e.message);
      }
    }
  }

  _handleMessage(message) {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      // Es una respuesta a un request nuestro
      const { resolve, reject } = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || 'LSP error'));
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // Es una notificación del servidor (e.g., textDocument/publishDiagnostics)
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('lsp:notification', {
          method: message.method,
          params: message.params,
        });
      }
    }
  }
}

module.exports = { LspManager };
