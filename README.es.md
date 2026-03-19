# MojaveCode PHP

Un editor de codigo ligero y completo, pensado para desarrolladores PHP por **[MojaveWare](https://mojaveware.com)**.

MojaveCode nace para llenar el hueco entre IDEs pesados como PHPStorm y editores genericos como VS Code que necesitan docenas de extensiones para ser utiles con PHP. Viene con todo lo que un desarrollador PHP/Laravel necesita desde el primer momento: LSP, terminal, integracion con git, Composer, Artisan, PHPUnit, visor de base de datos y mas — todo dentro de un shell Electron rapido con un diseno inspirado en Mojave.

Construido con Electron, Monaco Editor y xterm.js.

---

## Primeros pasos

### Requisitos previos

- **Node.js** >= 18
- **npm** >= 9
- **Git** en el PATH
- **Opcional** (para el visor de base de datos): clientes CLI `mysql` y/o `psql` en el PATH

### Clonar e instalar

```bash
git clone https://github.com/mojaveware/mojavecode-php.git
cd mojavecode-php
npm install
```

### Recompilar modulos nativos

`node-pty` es un modulo nativo C/C++ que debe compilarse contra la version de Node.js de Electron. Si te saltas este paso la terminal no funcionara.

```bash
npx electron-rebuild
```

Si falla, prueba `npm rebuild node-pty`. El editor arranca sin el, pero la terminal integrada no podra ejecutar comandos reales del sistema.

### Ejecutar en desarrollo

```bash
npm run dev
```

### Ejecutar en modo produccion

```bash
npm start
```

---

## Compilar para distribucion

MojaveCode usa **electron-builder** para empaquetar la app. Los archivos se generan en la carpeta `dist/`.

### Compilar para tu plataforma actual

```bash
npm run build
```

Detecta automaticamente tu sistema operativo y crea el paquete correspondiente.

### macOS (.dmg)

**Requisitos:**
- macOS (la compilacion cruzada desde otras plataformas no esta soportada por Apple)
- Xcode Command Line Tools: `xcode-select --install`

```bash
npm run build:mac
```

Resultado: `dist/MojaveCode PHP-<version>.dmg`

Para instalar, abre el `.dmg` y arrastra MojaveCode PHP a la carpeta Aplicaciones. En el primer arranque macOS puede pedir que lo permitas en Ajustes del Sistema > Privacidad y Seguridad ya que la app no esta notarizada.

> **Firma de codigo y notarizacion (opcional):** Para distribuir fuera de tu maquina necesitas una cuenta de Apple Developer. Configura las variables de entorno `CSC_LINK` y `CSC_KEY_PASSWORD` con tu certificado `.p12`, y agrega `"notarize": true` en la seccion `mac` de `package.json`. Consulta la [documentacion de electron-builder](https://www.electron.build/code-signing) para mas detalles.

### Windows (instalador .exe)

**Requisitos:**
- Windows 10/11 (o compilacion cruzada desde macOS/Linux con Wine — no recomendado)
- Visual Studio Build Tools (para compilar `node-pty`): descarga desde [visualstudio.microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/) e instala la carga de trabajo "Desarrollo de escritorio con C++"

```bash
npm run build:win
```

Resultado: `dist/MojaveCode PHP Setup <version>.exe`

El instalador esta construido con NSIS. Ejecuta el `.exe` para instalar — crea un acceso directo en el Menu Inicio y un desinstalador en Agregar/Quitar Programas. Windows Defender SmartScreen puede mostrar una advertencia ya que la app no esta firmada.

> **Firma de codigo (opcional):** Para evitar las advertencias de SmartScreen, firma el ejecutable con un certificado EV o estandar. Configura las variables `CSC_LINK` y `CSC_KEY_PASSWORD` antes de compilar. Consulta la [documentacion de electron-builder](https://www.electron.build/code-signing).

### Linux (.AppImage)

**Requisitos:**
- Una distro basada en Debian/Ubuntu (o cualquier distro con `glibc >= 2.31`)
- Herramientas de compilacion: `sudo apt install build-essential libx11-dev libxkbfile-dev`

```bash
npm run build:linux
```

Resultado: `dist/MojaveCode PHP-<version>.AppImage`

Para ejecutar:

```bash
chmod +x "dist/MojaveCode PHP-<version>.AppImage"
./"dist/MojaveCode PHP-<version>.AppImage"
```

AppImage es un formato portable — no necesita instalacion. Para integracion con el escritorio (icono en el lanzador), usa [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) o mueve el archivo a `~/Applications/` y crea una entrada `.desktop` manualmente.

> **Formatos alternativos:** Puedes cambiar el target de Linux en `package.json` bajo `build.linux.target` a `deb`, `rpm` o `snap` si prefieres un formato de paquete nativo.

### Notas sobre compilacion cruzada

| Compilando en | macOS | Windows | Linux |
|---|---|---|---|
| **macOS** | nativo | no soportado | no soportado |
| **Windows** | no soportado | nativo | no soportado |
| **Linux** | no soportado | no soportado | nativo |

Electron-builder tecnicamente soporta algunos escenarios de compilacion cruzada, pero `node-pty` (modulo nativo C++) debe compilarse para el sistema operativo destino. Lo mas fiable es compilar en cada plataforma de forma nativa, o usar CI (GitHub Actions) con una matrix de runners `macos-latest`, `windows-latest` y `ubuntu-latest`.

---

## Funcionalidades

### Editor

- **Monaco Editor** — el mismo motor detras de VS Code, con resaltado de sintaxis para 30+ lenguajes
- **Temas** — Mojave Dark y Mojave Light integrados, mas un **generador de temas** para crear temas custom ilimitados a partir de 3 colores (fondo, acento, texto). Los temas custom se persisten entre sesiones y aparecen en la barra de menu nativa
- **Gestion de pestanas** — avisos de cambios sin guardar, indicadores de modificacion, **reordenamiento con drag & drop**, multiples pestanas especiales (terminal, git graph, diff, output, base de datos, rutas, logs)
- **Vista Diff** — comparacion lado a lado para cambios staged y unstaged de git
- **Zoom** (`Cmd+=` / `Cmd+-` / `Cmd+0`) — ajusta el tamano de fuente del editor de 8px a 40px con altura de linea proporcional. Indicador de porcentaje en la barra de estado (click para resetear). Persistido entre sesiones via localStorage
- **Buscar y Reemplazar** (`Cmd+H`)
- **Multi-cursor** (`Cmd+D`) — soporte nativo de Monaco
- **Apertura rapida** (`Cmd+P`) — busqueda fuzzy de archivos en todo el proyecto
- **Ir a simbolo** (`Cmd+T`) — busqueda fuzzy de clases, funciones, metodos y constantes en todos los archivos del proyecto, con iconos por tipo
- **Busqueda en archivos** (`Cmd+Shift+F`) — busqueda de texto completo y regex en el proyecto con toggle de sensibilidad a mayusculas, resultados agrupados por archivo, navegacion click-a-linea
- **Panel de Outline** — clases, metodos, funciones, constantes y variables extraidos por archivo, agrupados por tipo con secciones colapsables

### PHP y Laravel

- **LSP Intelephense** integrado — autocompletado, ir-a-definicion, documentacion hover, ayuda de firma y diagnosticos en tiempo real sin necesidad de extensiones
- **Snippets de Blade** — 60+ directivas incluyendo flujo de control, bucles, layout, componentes, Livewire, atributos HTML (`@class`, `@checked`, `@disabled`...) y mas
- **Snippets inteligentes de PHP** — sensibles al contexto: `fn`/`fnp`/`fnr`/`fns` generan metodos con la visibilidad correcta dentro de una clase, o funciones independientes fuera de ella. Incluye `cpr` para promocion de constructor (PHP 8+), `prop`/`propr` para propiedades, `test`/`testa` para metodos PHPUnit, definiciones de `class`/`interface`/`trait`/`enum`
- **Auto-namespace** — abre un archivo `.php` vacio dentro de un directorio mapeado con PSR-4 y el editor genera el boilerplate completo (`<?php`, `namespace`, `class`) automaticamente, leyendo los mapeos de `composer.json`
- **Formateo PHP al guardar** — detecta Laravel Pint o PHP CS Fixer en el proyecto y formatea archivos `.php` al guardar. Desactivado por defecto, se activa desde el menu PHP. Restaura la posicion del cursor despues del formateo
- **Runner de PHPUnit** — ejecuta todos los tests, el archivo actual o el metodo actual (detecta `test_*` y `@test`) desde el menu PHP. Resultados mostrados en la pestana Output

### Integracion con Composer

El menu Composer siempre esta visible en la barra de menu. Los comandos especificos del proyecto aparecen cuando se detecta `composer.json`:

- **Nuevo Proyecto Laravel...** — siempre disponible. Crea un nuevo proyecto Laravel con `composer create-project`: pide el nombre del proyecto, permite elegir la carpeta destino, ejecuta la instalacion (con timeout de 10 minutos para conexiones lentas) y abre el nuevo proyecto automaticamente al completarse
- **Install** / **Update** — ejecucion con un click
- **Require** / **Require Dev** / **Remove** — dialogo de entrada para el nombre del paquete
- **Dump Autoload**
- **Run Script** — ejecuta cualquier script definido en `composer.json`
- El output se muestra en una pestana dedicada. El arbol de archivos se refresca despues de operaciones que modifican archivos

### Runner de Artisan (Laravel)

Se detecta automaticamente cuando `artisan` esta presente. Menu nativo de macOS con:

- **Make** — 16 generadores: Model, Controller, Migration, Seeder, Factory, Middleware, Request, Resource, Event, Listener, Job, Mail, Notification, Policy, Command, Test
- **Migrate** — ejecutar, rollback, fresh, status
- **Cache** — limpiar/cachear para app, config, rutas, vistas
- **Route List** — ejecucion rapida
- **Tinker** — abre una sesion interactiva en la terminal integrada
- **Comando personalizado** — ejecuta cualquier comando artisan con entrada de texto libre
- **Laravel Modules** (nwidart/laravel-modules) — si se detecta en `composer.json`, agrega un submenu Modules con `module:make`, `module:make-model`, `module:make-controller`, `module:migrate`, `module:enable`, `module:disable` y mas

### Visor de Base de Datos

Accesible desde la barra de acciones del sidebar o el menu View. Lee las credenciales de la base de datos desde el archivo `.env` del proyecto y se conecta via CLI de `mysql` o `psql`:

- **Soporte multi-base de datos** — detecta automaticamente todas las conexiones en el archivo `.env`. Soporta `DB_DATABASE` (por defecto), `DB_{PREFIJO}_DATABASE` (ej: `DB_ADMIN_DATABASE`) y `DB_DATABASE_{SUFIJO}` (ej: `DB_DATABASE_BLOG`). Cada base de datos se muestra como una seccion colapsable con su propia info de conexion y conteo de tablas. Las credenciales por conexion se resuelven automaticamente (ej: `DB_ADMIN_HOST`, `DB_ADMIN_USERNAME`) con fallback a las credenciales por defecto
- Muestra todas las tablas con columnas expandibles (nombre, tipo, nullable, indicadores de clave primaria/foranea)
- **Panel de consultas** por tabla — selecciona una columna, elige un operador (`=`, `LIKE`, `IS NULL`, etc.), ingresa un valor y busca. O carga todas las filas con un click
- **Edicion inline** — doble click en cualquier celda (excepto la clave primaria) para editar su valor. Enter para guardar (`UPDATE` via CLI), Escape para cancelar. Un flash visual confirma el guardado
- Resultados mostrados en una tabla formateada con headers sticky, resaltado hover y estilo para NULL
- Busqueda de tablas (`Cmd+F`) filtra en todas las bases de datos — las secciones sin coincidencias se ocultan automaticamente
- Soporta MySQL y PostgreSQL

### Lista de Rutas de Laravel

Accesible desde la barra de acciones del sidebar o el menu View. Ejecuta `php artisan route:list --json` y muestra:

- Todas las rutas en una tabla formateada con columnas Method, URI, Name y Action
- Badges de metodo con colores: GET (verde), POST (azul), PUT/PATCH (amarillo), DELETE (rojo)
- Click en una accion de controller para abrir el archivo PHP directamente (resolucion de namespace PSR-4 a ruta)

### Visor de Logs

Accesible desde la barra de acciones del sidebar. Lee todos los archivos de log de `storage/logs` (no solo `laravel.log`):

- **Panel en el sidebar** — reemplaza el arbol de archivos (mismo patron que los paneles de Git y Busqueda), lista todos los archivos de log ordenados por nombre
- **Vista formateada** — parsea el formato de log de Laravel (`[timestamp] env.LEVEL: mensaje`) en entradas estructuradas con codigo de colores
- **Badges de nivel de log** — ERROR (rojo), WARNING (amarillo), INFO (azul), DEBUG (gris)
- **Stack traces colapsables** — click en la flecha para expandir/colapsar
- **Pretty-printing de JSON** — objetos JSON embebidos en mensajes de log se detectan y formatean automaticamente con indentacion
- **Filtros por nivel** — filtra por Todos, Error, Warning, Info o Debug con un click
- **Busqueda de texto** — filtrado en tiempo real con coincidencias resaltadas en mensajes y stack traces. Se combina con los filtros de nivel
- **Boton de refrescar** — recarga el log actual sin cerrar la pestana

### Terminal

- **Terminal integrada** con xterm.js + node-pty
- Arranca en el directorio raiz del proyecto y se reinicia al cambiar de proyecto
- Soporte completo de colores, URLs clickeables, scroll suave
- Se redimensiona automaticamente con el layout del editor
- **Ciclo de vida limpio** — cerrar la pestana de terminal mata el proceso pty subyacente; al volver a abrirla siempre se crea una shell nueva con un entorno limpio

### Integracion con Claude Code

Panel en el sidebar (icono de bombilla en la barra de acciones) que lee el directorio `.claude/` del proyecto y muestra tus extensiones personalizadas de Claude Code:

- **SKILLS** — muestra skills personalizadas de `.claude/skills/*/SKILL.md` y slash commands de `.claude/commands/*.md`. Cada entrada muestra su nombre y hasta 5 lineas de descripcion
- **AGENTS** — muestra agentes personalizados de `.claude/agents/*.md` con su modelo e indicador de color
- **Busqueda en el arbol de directorios** — encuentra automaticamente el directorio `.claude/` subiendo por el sistema de archivos desde la carpeta del proyecto actual, por lo que los sub-proyectos anidados se manejan correctamente
- **HISTORY** — tercera seccion colapsable que muestra los ultimos 10 prompts humanos enviados a Claude Code en este proyecto. Cada entrada muestra un timestamp (hora si es de hoy, fecha corta si es de otro dia), hasta 4 lineas del prompt y un snippet de una linea de la respuesta de Claude
- **Dashboard de detalle** — haz click en cualquier skill, comando, agente o prompt del historial para abrir una pestana dedicada. Skills y agentes muestran el Markdown completo con badges de tipo/modelo/version y chips de herramientas. Los prompts del historial muestran un bloque `YOU` con el prompt completo y un bloque `CLAUDE` con la respuesta renderizada en Markdown
- Campos de frontmatter parseados: `name`, `description`, `model`, `version`, `tools`, `color`
- El historial se lee de `~/.claude/projects/` — sin configuracion, Claude Code graba las conversaciones automaticamente. Funciona con cualquier ruta de proyecto incluyendo las que tienen puntos en los nombres de directorio (ej: `proyecto.2026`)

### Integracion con Git

- **Panel de Source Control** — archivos staged, unstaged y untracked con stage/unstage/discard en un click
- **Commit** directamente desde el sidebar
- **Push / Pull** — botones en el panel de git con feedback visual (estado de sincronizacion y mensajes de error)
- **Selector de ramas** (`Cmd+Shift+B`) — paleta estilo VS Code para cambiar de rama con busqueda instantanea. Muestra ramas locales y remotas, con la rama actual y main/master siempre al tope. Tambien accesible haciendo click en el nombre de la rama en la barra de estado. Las ramas solo remotas se marcan y crean automaticamente una tracking branch local al hacer checkout
- **Auto-refresco de rama** — el nombre de la rama en la barra de estado y el panel de git se actualizan automaticamente cuando ejecutas comandos git (checkout, switch, etc.) en la terminal integrada
- **Sincronizacion desde la barra de estado** — botones Pull (↓) y Push (↑) junto al nombre de la rama en la barra de estado para sincronizacion rapida con un click, con animacion de giro mientras se ejecuta
- **Git Graph** — visualizacion SVG del historial de commits, ramas y tags
- **Vista Diff** — se abre al hacer click en archivos del panel de git

### Interfaz y Navegacion

- **Barra de acciones del sidebar** con acceso rapido a Busqueda, Terminal, Git, Base de Datos, Rutas, Logs e integracion con Claude Code
- **Arbol de archivos** con carga lazy, iconos material, **auto-reveal** (activar una pestana expande y hace scroll hasta el archivo en el arbol, como el "Reveal in Side Bar" de VS Code) y **menu contextual con click derecho** (Copiar Ruta, Copiar, Pegar, Eliminar)
- **Sidebar redimensionable** — arrastra el borde derecho para ajustar el ancho (150px–600px)
- **Barra de breadcrumb** — muestra la ruta relativa del archivo activo entre la barra de pestanas y el editor, facilitando distinguir archivos con el mismo nombre en diferentes directorios
- **Secciones del sidebar colapsables** — el outline llena el espacio disponible cuando el arbol de archivos esta colapsado
- **Carpetas recientes** — las ultimas 5 carpetas abiertas se muestran en la pantalla de bienvenida para acceso con un click, y en File > Open Recent en la barra de menu nativa. Persistido entre sesiones
- **Auto Save** — activar desde File > Auto Save. Guarda automaticamente 1 segundo despues de la ultima pulsacion de tecla
- **Log de Errores** — captura `console.error`, errores no manejados y promesas rechazadas. Badge rojo en la barra de estado, pestana dedicada con boton de limpiar
- **Monitor del sistema** — uso de CPU y RAM en la barra de estado

---

## Atajos de teclado

| Atajo | Accion |
|---|---|
| `Cmd+O` | Abrir carpeta |
| `Cmd+Shift+O` | Abrir archivo |
| `Cmd+Shift+P` | Paleta de comandos |
| `Cmd+P` | Apertura rapida (busqueda fuzzy de archivos) |
| `Cmd+T` | Ir a simbolo (busqueda fuzzy de simbolos) |
| `Cmd+Shift+F` | Buscar en archivos |
| `Cmd+S` | Guardar archivo |
| `Cmd+Shift+S` | Guardar como |
| `Cmd+W` | Cerrar pestana activa |
| `Cmd+\` | Toggle editor dividido |
| `Cmd+Shift+B` | Cambiar rama de Git |
| `Cmd+B` | Mostrar/ocultar sidebar |
| `Cmd+`` ` | Mostrar/ocultar terminal |
| `Cmd+H` | Buscar y reemplazar |
| `Cmd+=` | Acercar zoom |
| `Cmd+-` | Alejar zoom |
| `Cmd+0` | Resetear zoom |
| `Cmd+D` | Agregar seleccion a la siguiente coincidencia (multi-cursor) |

---

## Estructura del proyecto

```
mojavecode-php/
├── src/
│   ├── main/                        # Proceso principal de Electron (Node.js)
│   │   ├── main.js                  # Ventana, menus, IPC, pty, git, composer, artisan, db, busqueda
│   │   ├── preload.js               # Puente seguro de contexto (renderer <-> main)
│   │   ├── lsp-manager.js           # Ciclo de vida de Intelephense (JSON-RPC 2.0 sobre stdio)
│   │   └── db-helper.js             # Parseo de .env, deteccion multi-DB, ejecucion SQL via CLI
│   │
│   └── renderer/                    # Proceso renderer de Electron (Chromium)
│       ├── index.html               # Shell de la app: titlebar, sidebar, area de editor, dialogos, statusbar
│       ├── renderer.js              # Logica de UI, manejo de estado, todos los paneles de funcionalidades
│       ├── lsp-client.js            # Providers Monaco <-> LSP, snippets Blade, snippets inteligentes PHP
│       └── styles/
│           └── editor.css           # Sistema de diseno con variables CSS (temas dark + light)
│
├── package.json
├── README.md                        # Documentacion en ingles
└── README.es.md                     # Documentacion en espanol
```

---

## Arquitectura

```
┌──────────────────────────────────────────────────────────┐
│                     APP ELECTRON                           │
│                                                           │
│  ┌────────────────────┐  IPC  ┌────────────────────────┐ │
│  │  Proceso Principal  │<----->│  Proceso Renderer      │ │
│  │    (Node.js)        │       │    (Chromium)           │ │
│  │                     │       │                         │ │
│  │ - Filesystem        │       │ - Monaco Editor         │ │
│  │ - node-pty          │       │ - xterm.js              │ │
│  │ - Git (execFile)    │       │ - Arbol de Archivos     │ │
│  │ - Gestor LSP        │       │ - Gestor de Pestanas    │ │
│  │ - Menus nativos     │       │ - Panel Git & Graph     │ │
│  │ - Composer/Artisan  │       │ - Busqueda (archivos)   │ │
│  │ - Consultas DB (CLI)│       │ - Apertura Rapida       │ │
│  │ - PHPUnit/Pint      │       │ - Visor de DB           │ │
│  │ - Resolver PSR-4    │       │ - Lista de Rutas        │ │
│  │ - Lector de logs    │       │ - Visor de Logs         │ │
│  │ - Motor de busqueda │       │ - Selector de Tema      │ │
│  │ - Dialogos          │       │ - Log de Errores        │ │
│  └────────────────────┘       └────────────────────────┘ │
│          │                              │                 │
│          └──── preload.js (puente seguro) ───┘            │
└──────────────────────────────────────────────────────────┘
```

### Proceso Principal (`main.js`)

Corre en Node.js. Maneja todo lo que necesita acceso a nivel de sistema operativo:

- **Gestion de ventana** — BrowserWindow sin marco con titlebar personalizado
- **Menus nativos dinamicos** — File, Edit, View, Terminal, Git, Composer (siempre visible, comandos de proyecto condicionales), Artisan (si se detecta, con soporte de Modules), PHP (formateo al guardar + PHPUnit), Tema, Help
- **Deteccion de proyecto** — escanea la carpeta abierta buscando `composer.json`, `artisan`, `pint.json`, `.php-cs-fixer.php`, `phpunit.xml` y `nwidart/laravel-modules`. Reconstruye los menus dinamicamente segun lo que encuentre
- **Handlers IPC** — filesystem (leer, escribir, eliminar, copiar), git (via `execFile`, seguro contra inyeccion), gestion de PTY, ciclo de vida LSP, motor de busqueda, extraccion de simbolos, ejecucion de comandos Composer/Artisan, consultas a base de datos, lista de rutas, lectura de archivos de log, resolucion de namespaces PSR-4, formateo PHP, ejecucion PHPUnit, monitoreo de CPU, auto-save, sincronizacion de tema
- **Acceso a base de datos** — parsea `.env` para credenciales (detecta automaticamente multiples conexiones de base de datos), consulta via CLI de `mysql`/`psql` (no necesita drivers de base de datos de npm)

### Preload (`preload.js`)

Puente seguro via `contextBridge.exposeInMainWorld`. Cada canal IPC esta explicitamente en whitelist — sin wildcards. `nodeIntegration: false`, `contextIsolation: true`.

### Renderer (`renderer.js`)

Aplicacion de pagina unica con estado mutable centralizado. Organizado en secciones numeradas que cubren inicializacion del editor, terminal (con auto-refresco de rama git y ciclo de vida limpio del pty), arbol de archivos (con menu contextual y auto-reveal), pestanas (con reordenamiento drag & drop), guardado (con auto-save), barra de breadcrumb, deteccion de lenguaje, toggles de UI (redimensionamiento del sidebar), panel de git, selector de ramas (paleta estilo command palette), cambio de tema y generador de temas custom (motor de derivacion de colores con preview en vivo), log de errores, apertura rapida, panel de busqueda, busqueda de simbolos, visor de base de datos, lista de rutas, visor de logs (formateado con busqueda y filtros), integracion Composer/Artisan (incluyendo Nuevo Proyecto Laravel), herramientas PHP, monitoreo del sistema y panel de integracion con Claude Code (skills, comandos, agentes con dashboard de detalle).

### Cliente LSP (`lsp-client.js`)

Conecta Monaco con Intelephense mediante providers para autocompletado, hover, definicion, ayuda de firma y diagnosticos. Tambien registra completados de directivas Blade (60+ snippets, solo en archivos `.blade.php`) y snippets inteligentes de PHP que detectan si el cursor esta dentro de una clase o a nivel superior.

### Temas

Variables CSS en `[data-theme="dark"]` / `[data-theme="light"]`. El cambio de tema es instantaneo — actualiza variables CSS, tema de Monaco, colores ANSI de la terminal y radio buttons del menu nativo en un solo paso. Persistido en `localStorage`.

Colores derivados de la marca MojaveWare:
- **Dark**: azules profundos (`#0d1a2a`, `#112240`) + naranja atardecer (`#E85324`) + texto arena (`#F4E2CE`)
- **Light**: arena calida (`#FEFAF7`, `#F4E2CE`) + texto azul profundo (`#1F4266`) + mismo naranja de acento

**Generador de Temas** (`Tema > Generate Theme...`): crea temas personalizados a partir de 3 colores:
- **Fondo** — ~10 variantes derivadas automaticamente (darkest, panel, sidebar, hover, active, tabs, terminal, border) usando ajustes de luminosidad
- **Acento** — colores de sintaxis generados via rotacion de hue (+40 numeros, +100 strings, +130 tags, +160 funciones, +220 variables). Colores de UI (rojo, verde, azul, amarillo, teal) tambien derivados
- **Texto** — primary/secondary/muted derivados mezclando con el fondo en diferentes proporciones
- Detecta automaticamente dark vs light segun la luminosidad del fondo (ITU-R BT.601)
- Genera un tema Monaco completo (11 reglas de token + 15 colores del editor) y tema de terminal (16 colores ANSI)
- Mini-preview en vivo que se actualiza mientras eliges colores
- Los temas custom se guardan en `localStorage`, aparecen en el menu nativo Tema y se pueden eliminar desde `Tema > Delete Theme`

---

## Seguridad

- `nodeIntegration: false`, `contextIsolation: true`
- Todos los canales IPC explicitamente expuestos via preload (sin patrones wildcard)
- Los comandos git usan `execFile` con array de argumentos (sin interpolacion de shell)
- Las consultas de base de datos sanitizan nombres de tabla/columna a solo alfanumerico + guion bajo
- El `cd` de la terminal usa quoting seguro via handler dedicado `pty:cd`
- El recorrido de archivos esta limitado a 5,000 archivos / 15 niveles de profundidad para prevenir agotamiento de recursos
- `sandbox: false` es requerido para node-pty (trade-off documentado)

---

## Stack Tecnologico

| Componente | Libreria | Proposito |
|---|---|---|
| Framework | Electron 33 | Shell de app de escritorio |
| Editor | Monaco Editor 0.52 | Edicion de codigo, resaltado de sintaxis, diff |
| Terminal | xterm.js 5.5 | Emulador de terminal |
| PTY | node-pty 1.0 | Backend de shell real |
| LSP | Intelephense 1.16 | Servidor de lenguaje PHP |
| Iconos | material-file-icons 2.4 | Iconos del arbol de archivos |
| Build | electron-builder 25 | Empaquetado y distribucion |

Sin dependencias adicionales de runtime para acceso a base de datos (usa CLI de `mysql`/`psql`) ni herramientas PHP (usa `composer`, `php`, `vendor/bin/*` del proyecto).

---

## Limitaciones conocidas

- El LSP solo soporta PHP (Intelephense). Otros lenguajes tienen resaltado de sintaxis pero no autocompletado ni diagnosticos
- Sin UI de configuracion — el tamano de tabulacion y otras preferencias estan hardcodeadas (el tamano de fuente es ajustable via zoom)
- El visor de base de datos requiere que `mysql`, `psql` o `sqlite3` CLI esten instalados localmente
- Sin integracion con Xdebug (breakpoints/debugging)

---

## Hoja de ruta

### Planificado
- [ ] Integracion con Xdebug (breakpoints y debugging paso a paso)
- [ ] Visor de `.env` con resaltado de sintaxis y secretos ocultos
- [ ] UI de configuracion/preferencias
- [ ] Multiples instancias de terminal

---

## Changelog

### v2.5.0

- **Paleta de comandos** — `Cmd+Shift+P` abre un buscador de todos los comandos del editor, agrupados por categoria (File, View, Go, Git, Theme, PHP, Laravel). Los comandos de PHP y Laravel solo aparecen cuando el proyecto tiene las herramientas correspondientes detectadas (PHPUnit, Artisan, Pint).
- **Editor dividido** — `Cmd+\` divide el editor en dos paneles independientes. Cada panel tiene su propia barra de pestanas, breadcrumb e instancia de Monaco. Los archivos compartidos entre paneles usan el mismo TextModel, manteniendo ediciones e historial de undo sincronizados.
- **File Watcher** — Detecta cambios externos en los archivos abiertos (git checkout, generadores de artisan, formatters externos). Recarga silenciosamente si el archivo no tiene cambios sin guardar; muestra una barra de advertencia si hay conflictos.
- **SQLite en DB Viewer** — El visor de base de datos ahora soporta conexiones SQLite definidas en `.env` (`DB_CONNECTION=sqlite`). Usa el CLI `sqlite3` (preinstalado en macOS) — sin dependencias adicionales.

---

## Licencia

MIT — MojaveWare
