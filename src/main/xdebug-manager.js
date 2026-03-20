// ────────────────────────────────────────────────────────────────
// XDEBUG MANAGER — DBGp Protocol Server
// ────────────────────────────────────────────────────────────────
//
// Servidor TCP que escucha conexiones de Xdebug via el protocolo
// DBGp. Cuando PHP ejecuta un script con Xdebug habilitado, se
// conecta a este servidor como cliente. El manager parsea el XML
// de las respuestas DBGp y envía comandos para controlar la
// ejecución: breakpoints, step over/into/out, inspección de
// variables, y call stack.
//
// Protocolo DBGp:
//  - Xdebug → Manager: "<length>\0<xml>\0" (longitud en ASCII + XML)
//  - Manager → Xdebug: "command -i txn_id [args]\0" (null-terminated)
//  - XML de respuestas es flat con atributos, raramente anidado.
//
// Referencia: https://xdebug.org/docs/dbgp

const net = require('net');
const config = require('../config');

class XdebugManager {
  /**
   * @param {Electron.BrowserWindow} mainWindow - Ventana principal para enviar eventos al renderer
   */
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.server = null;
    this.socket = null;
    this.state = 'idle'; // idle | listening | connected | break | running | stopped
    this.transactionId = 0;
    this.pendingTransactions = new Map();
    this.buffer = Buffer.alloc(0);

    // Path mapping para Docker/Sail: remotePath → localPath
    this.pathMappings = [];

    // Breakpoints almacenados en el main process para setup inmediato
    // al conectar, sin esperar al renderer. { "filePath:line": { filePath, line } }
    this.storedBreakpoints = {};

    // URI del archivo reportado por Xdebug en el init packet — lo usamos
    // para setear breakpoints con el URI exacto que Xdebug reconoce.
    this.initFileUri = null;

    // Flag para suprimir eventos break durante el step_into inicial
    this._initializing = false;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Inicia el servidor TCP y escucha en el puerto dado.
   * Xdebug se conectará a este puerto como cliente.
   *
   * @param {number} port - Puerto TCP (default 9003 para Xdebug 3)
   * @param {Array} pathMappings - [{remote: '/var/www/html', local: '/Users/...'}]
   */
  startListening(port, pathMappings = []) {
    if (this.server) return { error: 'Already listening' };

    this.pathMappings = pathMappings;

    return new Promise((resolve) => {
      this.server = net.createServer((socket) => {
        this._onConnection(socket);
      });

      this.server.on('error', (err) => {
        console.error('[Xdebug] Server error:', err.message);
        this._setState('idle');
        resolve({ error: err.message });
      });

      this.server.listen(port || config.xdebug.defaultPort, () => {
        console.log(`[Xdebug] Listening on port ${port || config.xdebug.defaultPort}`);
        this._setState('listening');
        resolve({ success: true, port: port || config.xdebug.defaultPort });
      });
    });
  }

  /**
   * Detiene el servidor TCP y cierra cualquier sesión activa.
   */
  stopListening() {
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ok */ }
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.pendingTransactions.clear();
    this.buffer = Buffer.alloc(0);
    this._setState('idle');
    return { success: true };
  }

  // ── Connection handling ────────────────────────────────────

  /**
   * Maneja una nueva conexión entrante de Xdebug.
   * Solo acepta una sesión a la vez — rechaza conexiones adicionales.
   */
  _onConnection(socket) {
    if (this.socket) {
      // Si estamos pausados en un breakpoint, NO reemplazar — el usuario
      // está inspeccionando variables. La nueva conexión es probablemente
      // un request irrelevante (favicon, AJAX, etc.).
      if (this.state === 'break') {
        console.log('[Xdebug] Rejecting connection (paused at breakpoint)');
        socket.destroy();
        return;
      }
      // Si estamos en running/connected, reemplazar — la nueva conexión
      // puede ser el request que sí pasa por el breakpoint.
      console.log('[Xdebug] Replacing previous connection with new one');
      try { this.socket.removeAllListeners(); this.socket.destroy(); } catch { /* ok */ }
      this.pendingTransactions.clear();
    }

    console.log('[Xdebug] Client connected');
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.transactionId = 0;
    this.pendingTransactions.clear();
    this._setState('connected');

    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('end', () => {
      console.log('[Xdebug] Client disconnected');
      this.socket = null;
      this._setState('listening');
      this._emit('xdebug:session-end', {});
    });

    socket.on('error', (err) => {
      console.error('[Xdebug] Socket error:', err.message);
      this.socket = null;
      this._setState('listening');
      this._emit('xdebug:session-end', {});
    });
  }

  // ── DBGp Protocol Parsing ─────────────────────────────────

  /**
   * Parsea datos entrantes del socket usando el framing DBGp:
   * <length>\0<xml>\0
   *
   * Los datos pueden llegar fragmentados, así que acumulamos en
   * un buffer y procesamos solo cuando tenemos un paquete completo.
   */
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length > 0) {
      // Buscar el primer null byte (fin de la longitud)
      const nullIdx = this.buffer.indexOf(0);
      if (nullIdx === -1) break;

      // Parsear la longitud
      const lengthStr = this.buffer.slice(0, nullIdx).toString('ascii');
      const dataLength = parseInt(lengthStr, 10);
      if (isNaN(dataLength)) {
        // Dato corrupto — limpiar buffer
        this.buffer = Buffer.alloc(0);
        break;
      }

      // Verificar que tenemos el paquete completo: length + \0 + xml + \0
      const totalNeeded = nullIdx + 1 + dataLength + 1;
      if (this.buffer.length < totalNeeded) break;

      // Extraer el XML
      const xmlStr = this.buffer.slice(nullIdx + 1, nullIdx + 1 + dataLength).toString('utf-8');
      this.buffer = this.buffer.slice(totalNeeded);

      // Parsear y procesar
      try {
        const parsed = this._parseXml(xmlStr);
        this._handleMessage(parsed, xmlStr);
      } catch (err) {
        console.error('[Xdebug] Parse error:', err.message);
      }
    }
  }

  /**
   * Parser XML para DBGp que maneja correctamente tags anidados
   * del mismo nombre (ej. <property> dentro de <property>).
   *
   * @param {string} xml - String XML de la respuesta DBGp
   * @returns {object} Objeto parseado con tag, attrs, children, text
   */
  _parseXml(xml) {
    return this._parseElement(xml);
  }

  _parseElement(xml) {
    // Encontrar el primer tag de apertura (saltear <?xml ...?> y espacios)
    const openMatch = xml.match(/<([a-zA-Z_:][a-zA-Z0-9_:.-]*)((?:\s+[^>]*?)?)(\/?)>/);
    if (!openMatch) return { tag: 'unknown', attrs: {}, children: [], text: '' };

    const tag = openMatch[1];
    const attrStr = openMatch[2] || '';
    const selfClosing = openMatch[3] === '/';

    // Parsear atributos
    const attrs = {};
    const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)="([^"]*)"/g;
    let m;
    while ((m = attrRegex.exec(attrStr)) !== null) {
      attrs[m[1]] = m[2];
    }

    if (selfClosing) {
      return { tag, attrs, children: [], text: '' };
    }

    // Encontrar el closing tag correcto contando profundidad
    const contentStart = openMatch.index + openMatch[0].length;
    const innerXml = this._extractInnerXml(xml, tag, contentStart);

    // Extraer texto (CDATA o texto directo)
    let text = '';
    const cdataMatch = innerXml.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdataMatch) {
      text = cdataMatch[1];
    } else if (innerXml && !innerXml.includes('<')) {
      text = innerXml.trim();
    }

    // Parsear hijos iterando sobre el innerXml
    const children = this._extractChildren(innerXml);

    return { tag, attrs, children, text };
  }

  /**
   * Extrae el contenido entre un tag de apertura y su closing tag
   * correcto, contando profundidad para tags anidados del mismo nombre.
   */
  _extractInnerXml(xml, tag, startIdx) {
    const closeTag = `</${tag}>`;
    const openPattern = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|>|\\/)`, 'g');
    let depth = 1;
    let idx = startIdx;

    while (depth > 0 && idx < xml.length) {
      const nextClose = xml.indexOf(closeTag, idx);
      if (nextClose === -1) return xml.slice(startIdx); // no closing tag

      // Contar aperturas entre idx y nextClose
      openPattern.lastIndex = idx;
      let openMatch;
      while ((openMatch = openPattern.exec(xml)) !== null && openMatch.index < nextClose) {
        // Verificar que no sea self-closing
        const tagEnd = xml.indexOf('>', openMatch.index);
        if (tagEnd !== -1 && xml[tagEnd - 1] !== '/') {
          depth++;
        }
      }

      depth--; // por el closeTag encontrado
      if (depth === 0) {
        return xml.slice(startIdx, nextClose);
      }
      idx = nextClose + closeTag.length;
    }

    return xml.slice(startIdx);
  }

  /**
   * Extrae elementos hijo del innerXml, manejando anidamiento correcto.
   */
  _extractChildren(innerXml) {
    const children = [];
    const tagStartRegex = /<([a-zA-Z_:][a-zA-Z0-9_:.-]*)((?:\s+[^>]*?)?)(\/?)>/g;
    let match;

    while ((match = tagStartRegex.exec(innerXml)) !== null) {
      // Ignorar CDATA, comments, processing instructions
      if (innerXml[match.index + 1] === '!' || innerXml[match.index + 1] === '?') continue;
      // Ignorar closing tags
      if (innerXml[match.index + 1] === '/') continue;

      const childTag = match[1];
      const childAttrStr = match[2] || '';
      const isSelfClosing = match[3] === '/';

      if (isSelfClosing) {
        const attrs = {};
        const attrRegex = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)="([^"]*)"/g;
        let a;
        while ((a = attrRegex.exec(childAttrStr)) !== null) attrs[a[1]] = a[2];
        children.push({ tag: childTag, attrs, children: [], text: '' });
      } else {
        // Extraer el elemento completo con su contenido anidado
        const contentStart = match.index + match[0].length;
        const childInner = this._extractInnerXml(innerXml, childTag, contentStart);
        const fullEnd = contentStart + childInner.length + `</${childTag}>`.length;

        // Parsear recursivamente
        const fullElement = innerXml.slice(match.index, fullEnd);
        children.push(this._parseElement(fullElement));

        // Avanzar el regex past este elemento completo
        tagStartRegex.lastIndex = fullEnd;
      }
    }

    return children;
  }

  // ── Message handling ──────────────────────────────────────

  /**
   * Procesa un mensaje parseado de Xdebug.
   * Puede ser un init packet, una respuesta a un comando, o una notificación.
   */
  _handleMessage(parsed, rawXml) {
    const { tag, attrs, children } = parsed;

    // ── Init packet (primera respuesta al conectar) ──────────
    // Al recibir init, seteamos TODOS los breakpoints almacenados
    // y ejecutamos run INMEDIATAMENTE en el main process — sin pasar
    // por el renderer — para evitar que el script PHP termine antes
    // de que los breakpoints se registren.
    if (tag === 'init') {
      console.log('[Xdebug] Init:', attrs.fileuri, 'appid:', attrs.appid);
      this.initFileUri = attrs.fileuri || null;
      this._emit('xdebug:init', {
        fileUri: attrs.fileuri,
        appId: attrs.appid,
        ideKey: attrs.idekey,
        language: attrs.language,
      });
      this._negotiateAndRun();
      return;
    }

    // ── Response a un comando ────────────────────────────────
    if (tag === 'response') {
      const txnId = parseInt(attrs.transaction_id, 10);
      const pending = this.pendingTransactions.get(txnId);

      // Solo loguear respuestas de continuación (las más relevantes)
      if (['run', 'step_over', 'step_into', 'step_out', 'stop'].includes(attrs.command)) {
        console.log(`[Xdebug] ${attrs.command}: status=${attrs.status} reason=${attrs.reason}`);
      }

      // Detectar errores DBGp (vienen como child <error>, no como atributo)
      const errorChild = children.find((c) => c.tag === 'error');
      if (errorChild) {
        const errorCode = errorChild.attrs?.code || '?';
        const errorMsg = errorChild.children.find((c) => c.tag === 'message')?.text || 'Unknown error';
        console.error(`[Xdebug] Error in ${attrs.command}: code=${errorCode} — ${errorMsg}`);
        if (pending) {
          this.pendingTransactions.delete(txnId);
          pending.reject(new Error(`DBGp error ${errorCode}: ${errorMsg}`));
        }
        return;
      }

      // Solo cambiar estado para comandos de continuación (run/step_*).
      // Otros comandos (breakpoint_set, context_get, etc.) también traen
      // status en la respuesta pero refleja el estado ACTUAL del engine,
      // no un cambio de estado — procesarlos causaría eventos espurios.
      const isContinuation = ['run', 'step_over', 'step_into', 'step_out'].includes(attrs.command);

      if (isContinuation) {
        if (attrs.status === 'break') {
          this._setState('break');
          const msgChild = children.find((c) => c.tag === 'xdebug:message' || c.tag === 'message');
          const breakFile = msgChild?.attrs?.filename || attrs.filename || '';
          const breakLine = parseInt(msgChild?.attrs?.lineno || attrs.lineno || '0', 10);
          console.log(`[Xdebug] Break at ${breakFile}:${breakLine}`);

          // Suprimir evento break durante el step_into inicial
          if (this._initializing) {
            console.log('[Xdebug] (suppressed break event — initializing)');
          } else {
            this._emit('xdebug:break', {
              file: this._mapRemoteToLocal(breakFile),
              fileUri: breakFile,
              line: breakLine,
            });
          }
        } else if (attrs.status === 'stopping' || attrs.status === 'stopped') {
          console.log('[Xdebug] Script finished, cleaning up...');
          if (this.socket) {
            try { this.socket.removeAllListeners(); this.socket.destroy(); } catch { /* ok */ }
            this.socket = null;
          }
          this.pendingTransactions.clear();
          this._setState('listening');
          this._emit('xdebug:session-end', {});
        } else if (attrs.status === 'running') {
          this._setState('running');
        }
      }

      // Resolver la promesa pendiente
      if (pending) {
        this.pendingTransactions.delete(txnId);
        pending.resolve({ attrs, children, tag, rawXml });
      }
    }
  }

  // ── Command sending ───────────────────────────────────────

  /**
   * Envía un comando DBGp a Xdebug y devuelve una promesa que se
   * resuelve con la respuesta.
   *
   * Formato: "command -i txn_id [args]\0"
   *
   * @param {string} command - Nombre del comando DBGp
   * @param {object} args - Argumentos como {flag: value}
   * @param {string} data - Datos adicionales (base64, para eval)
   * @returns {Promise<object>} Respuesta parseada
   */
  sendCommand(command, args = {}, data = null) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('No active session'));

      const txnId = ++this.transactionId;
      this.pendingTransactions.set(txnId, { resolve, reject });

      let cmd = `${command} -i ${txnId}`;
      for (const [flag, value] of Object.entries(args)) {
        cmd += ` -${flag} ${value}`;
      }
      if (data) {
        cmd += ` -- ${Buffer.from(data).toString('base64')}`;
      }

      this.socket.write(cmd + '\0');

      // Timeout
      setTimeout(() => {
        if (this.pendingTransactions.has(txnId)) {
          this.pendingTransactions.delete(txnId);
          reject(new Error(`Timeout: ${command}`));
        }
      }, config.xdebug.connectionTimeout);
    });
  }

  /**
   * Negocia features con Xdebug y luego setea breakpoints + run.
   * Se llama automáticamente al recibir el init packet.
   *
   * Feature negotiation es necesaria para Xdebug 3.1+ — sin ella,
   * los breakpoints pueden quedar "unresolved" y no dispararse.
   */
  async _negotiateAndRun() {
    // ── Feature negotiation (como hace VS Code PHP Debug) ────
    const features = [
      ['max_depth', '2'],
      ['max_children', '256'],
      ['max_data', '2048'],
      ['show_hidden', '1'],
      ['extended_properties', '1'],
    ];

    for (const [name, value] of features) {
      try {
        await this.sendCommand('feature_set', { n: name, v: value });
      } catch { /* non-critical */ }
    }

    await this._autoSetBreakpointsAndRun();
  }

  /**
   * Setea todos los breakpoints almacenados y ejecuta run.
   * Usa el fileuri del init packet para máxima compatibilidad
   * con el path que Xdebug reconoce internamente.
   *
   * Secuencia: set breakpoints → step_into (compila archivo) → run.
   * El step_into inicial es necesario para que Xdebug resuelva los
   * breakpoints contra los opcodes compilados del script.
   */
  async _autoSetBreakpointsAndRun() {
    const bps = Object.values(this.storedBreakpoints);
    console.log(`[Xdebug] Setting ${bps.length} breakpoints...`);

    // Extraer path del init para usar el URI exacto de Xdebug
    const initPath = this.initFileUri ? this.initFileUri.replace(/^file:\/\//, '') : null;

    let setCount = 0;
    for (const bp of bps) {
      try {
        // Usar el URI del init packet si el breakpoint es para el mismo archivo
        const fileUri = (initPath && bp.filePath === initPath)
          ? this.initFileUri
          : this._mapLocalToRemote(bp.filePath);

        const result = await this._setBreakpointRaw(fileUri, bp.line);
        if (result.id) {
          setCount++;
          console.log(`[Xdebug]   ✓ ${bp.filePath}:${bp.line} → id=${result.id}`);
        } else {
          console.warn(`[Xdebug]   ✗ ${bp.filePath}:${bp.line} — no ID`);
        }
      } catch (err) {
        console.error(`[Xdebug]   ✗ ${bp.filePath}:${bp.line} FAILED:`, err.message);
      }
    }

    console.log(`[Xdebug] ${setCount}/${bps.length} breakpoints set. Starting engine...`);

    // step_into compila el script y para en el primer opcode.
    // Sin esto, Xdebug puede no resolver breakpoints correctamente.
    this._initializing = true;
    try {
      const stepResult = await this.stepInto();
      const stepMsg = stepResult.children?.find((c) => c.tag === 'xdebug:message' || c.tag === 'message');
      const stepLine = parseInt(stepMsg?.attrs?.lineno || stepResult.attrs?.lineno || '0', 10);
      const stepFile = stepMsg?.attrs?.filename || stepResult.attrs?.filename || '';

      // Si step_into paró en una línea con breakpoint, ya estamos ahí
      if (bps.some((bp) => bp.line === stepLine)) {
        this._initializing = false;
        this._emit('xdebug:break', {
          file: this._mapRemoteToLocal(stepFile),
          fileUri: stepFile,
          line: stepLine,
        });
        return;
      }

      // Continuar hasta el primer breakpoint
      this._initializing = false;
      await this.run();
    } catch (err) {
      this._initializing = false;
      console.error('[Xdebug] Init sequence failed:', err.message);
    }
  }

  /**
   * Sincroniza los breakpoints desde el renderer al main process.
   * Se llama cada vez que el usuario agrega o quita un breakpoint.
   *
   * @param {object} breakpoints - { filePath: [line1, line2, ...], ... }
   */
  syncBreakpoints(breakpoints) {
    this.storedBreakpoints = {};
    for (const [filePath, lines] of Object.entries(breakpoints)) {
      for (const line of lines) {
        this.storedBreakpoints[`${filePath}:${line}`] = { filePath, line };
      }
    }
  }

  // ── Breakpoints ───────────────────────────────────────────

  /**
   * Establece un breakpoint de línea en Xdebug.
   *
   * @param {string} filePath - Path local del archivo
   * @param {number} line - Número de línea
   * @returns {Promise<{id: string}>} ID del breakpoint asignado por Xdebug
   */
  async setBreakpoint(filePath, line) {
    const fileUri = this._mapLocalToRemote(filePath);
    return this._setBreakpointRaw(fileUri, line);
  }

  /**
   * Setea un breakpoint usando un URI ya formado (sin mapeo).
   */
  async _setBreakpointRaw(fileUri, line) {
    const result = await this.sendCommand('breakpoint_set', {
      t: 'line',
      f: fileUri,
      n: line,
    });
    return { id: result.attrs.id };
  }

  /**
   * Elimina un breakpoint por su ID de Xdebug.
   */
  async removeBreakpoint(breakpointId) {
    return this.sendCommand('breakpoint_remove', { d: breakpointId });
  }

  // ── Execution control ─────────────────────────────────────

  async run()      { return this.sendCommand('run'); }
  async stepOver() { return this.sendCommand('step_over'); }
  async stepInto() { return this.sendCommand('step_into'); }
  async stepOut()  { return this.sendCommand('step_out'); }

  async stop() {
    try {
      await this.sendCommand('stop');
    } catch { /* ok — script may have ended */ }
  }

  // ── Inspection ────────────────────────────────────────────

  /**
   * Obtener el call stack completo.
   * Devuelve un array de frames: [{level, where, file, line}, ...]
   */
  async getStackFrames() {
    const result = await this.sendCommand('stack_get');
    return result.children
      .filter((c) => c.tag === 'stack')
      .map((c) => ({
        level: parseInt(c.attrs.level, 10),
        where: c.attrs.where || '{main}',
        file: this._mapRemoteToLocal(c.attrs.filename || ''),
        fileUri: c.attrs.filename || '',
        line: parseInt(c.attrs.lineno, 10),
      }));
  }

  /**
   * Obtener los nombres de contextos disponibles en un frame.
   * Típicamente: 0=Locals, 1=Superglobals, 2=Constants
   */
  async getContextNames(depth = 0) {
    const result = await this.sendCommand('context_names', { d: depth });
    return result.children
      .filter((c) => c.tag === 'context')
      .map((c) => ({
        id: parseInt(c.attrs.id, 10),
        name: c.attrs.name,
      }));
  }

  /**
   * Obtener las variables de un contexto específico.
   * Devuelve un array de variables con sus tipos y valores.
   */
  async getContext(contextId, depth = 0) {
    const result = await this.sendCommand('context_get', { c: contextId, d: depth });
    return result.children
      .filter((c) => c.tag === 'property')
      .map((c) => this._parseProperty(c));
  }

  /**
   * Obtener el valor expandido de una variable (para objetos/arrays).
   */
  async getProperty(fullname, maxDepth = 2, contextId = 0) {
    const result = await this.sendCommand('property_get', {
      n: fullname,
      c: contextId,
    });
    const prop = result.children.find((c) => c.tag === 'property');
    return prop ? this._parseProperty(prop) : null;
  }

  /**
   * Parsea un elemento <property> de DBGp a un objeto JS.
   */
  _parseProperty(el) {
    const prop = {
      name: el.attrs.name || '',
      fullname: el.attrs.fullname || el.attrs.name || '',
      type: el.attrs.type || 'unknown',
      hasChildren: el.attrs.children === '1',
      numChildren: parseInt(el.attrs.numchildren || '0', 10),
      value: '',
      children: [],
    };

    // Valor: puede estar en base64 (encoding="base64") o en texto directo
    if (el.text) {
      prop.value = el.attrs.encoding === 'base64'
        ? Buffer.from(el.text, 'base64').toString('utf-8')
        : el.text;
    }

    // Hijos inline (para arrays/objetos que ya vienen expandidos)
    if (el.children.length > 0) {
      prop.children = el.children
        .filter((c) => c.tag === 'property')
        .map((c) => this._parseProperty(c));
    }

    return prop;
  }

  // ── Path mapping ──────────────────────────────────────────

  /**
   * Convierte un path local a file URI remoto (para Xdebug).
   * Si hay path mappings (Docker/Sail), aplica la conversión.
   */
  _mapLocalToRemote(localPath) {
    for (const { remote, local } of this.pathMappings) {
      if (localPath.startsWith(local)) {
        return 'file://' + localPath.replace(local, remote);
      }
    }
    return 'file://' + localPath;
  }

  /**
   * Convierte un file URI remoto de Xdebug a path local.
   */
  _mapRemoteToLocal(fileUri) {
    let path = fileUri.replace(/^file:\/\//, '');
    for (const { remote, local } of this.pathMappings) {
      if (path.startsWith(remote)) {
        return path.replace(remote, local);
      }
    }
    return path;
  }

  // ── Helpers ───────────────────────────────────────────────

  _setState(newState) {
    this.state = newState;
    this._emit('xdebug:state-changed', { state: newState });
  }

  _emit(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

module.exports = XdebugManager;
