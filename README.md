# MojaveCode PHP

A lightweight, batteries-included code editor built for PHP developers by **[MojaveWare](https://mojaveware.com)**.

MojaveCode is designed to fill the gap between heavy IDEs like PHPStorm and generic editors like VS Code that need dozens of extensions to be useful for PHP. It ships with everything a PHP/Laravel developer needs out of the box: an LSP, a terminal, git integration, Composer, Artisan, PHPUnit, a database viewer, and more — all wrapped in a fast Electron shell with a custom Mojave-inspired design.

Built with Electron, Monaco Editor, and xterm.js.

---

## Features

### Editor Core
- **Monaco Editor** — the same engine behind VS Code, with syntax highlighting for 30+ languages
- **Two themes** — Mojave Dark (deep blues + sunset orange) and Mojave Light (warm sand + deep blue), switchable from the native macOS menu bar
- **Tab management** — unsaved change warnings, modified indicators, multiple special tabs (terminal, git graph, diff, output, database, routes)
- **Diff view** — side-by-side comparison for staged and unstaged git changes
- **Find & Replace** (`Cmd+H`)
- **Multi-cursor** (`Cmd+D`) — native Monaco support
- **Quick Open** (`Cmd+P`) — fuzzy file search across the entire project
- **Go to Symbol** (`Cmd+T`) — fuzzy search for classes, functions, methods, and constants across all project files, with icons by kind
- **Search in Files** (`Cmd+Shift+F`) — full-text and regex search across the project with case sensitivity toggle, results grouped by file, click-to-line navigation
- **Outline panel** — classes, methods, functions, constants, and variables extracted per-file, grouped by kind with collapsible sections

### PHP & Laravel
- **Intelephense LSP** built-in — autocomplete, go-to-definition, hover docs, signature help, and real-time diagnostics with no extensions needed
- **Blade snippets** — 60+ directives including control flow, loops, layout, components, Livewire, HTML attributes (`@class`, `@checked`, `@disabled`...), and more
- **Smart PHP snippets** — context-aware: `fn`/`fnp`/`fnr`/`fns` generate methods with the right visibility inside a class, or standalone functions outside. Includes `cpr` for constructor promotion (PHP 8+), `prop`/`propr` for properties, `test`/`testa` for PHPUnit methods, `class`/`interface`/`trait`/`enum` definitions
- **Auto-namespace** — open an empty `.php` file inside a PSR-4 mapped directory and the editor generates the full boilerplate (`<?php`, `namespace`, `class`) automatically, reading the mappings from `composer.json`
- **PHP Format on Save** — detects Laravel Pint or PHP CS Fixer in the project and formats `.php` files on save. Disabled by default, toggle from the PHP menu. Restores cursor position after formatting
- **PHPUnit runner** — run all tests, the current file, or the current method (detects `test_*` and `@test`) from the PHP menu. Results shown in the Output tab

### Composer Integration
Automatically detected when `composer.json` is present. Native macOS menu with:
- **Install** / **Update** — one-click execution
- **Require** / **Require Dev** / **Remove** — input dialog for package name
- **Dump Autoload**
- **Run Script** — execute any script defined in `composer.json`
- Output shown in a dedicated tab. File tree refreshes after operations that modify files

### Artisan Runner (Laravel)
Automatically detected when `artisan` is present. Native macOS menu with:
- **Make** — 16 generators: Model, Controller, Migration, Seeder, Factory, Middleware, Request, Resource, Event, Listener, Job, Mail, Notification, Policy, Command, Test
- **Migrate** — run, rollback, fresh, status
- **Cache** — clear/cache for app, config, routes, views
- **Route List** — quick execution
- **Tinker** — opens an interactive session in the integrated terminal
- **Custom Command** — run any artisan command with a free-text input
- **Laravel Modules** (nwidart/laravel-modules) — if detected in `composer.json`, adds a Modules submenu with `module:make`, `module:make-model`, `module:make-controller`, `module:migrate`, `module:enable`, `module:disable`, and more

### Database Viewer
Accessible from the sidebar action bar or View menu. Reads database credentials from the project's `.env` file and connects via the `mysql` or `psql` CLI:
- Shows all tables with expandable columns (name, type, nullable, primary/foreign key indicators)
- **Query panel** per table — select a column, pick an operator (`=`, `LIKE`, `IS NULL`, etc.), enter a value, and search. Or load all rows with one click
- **Inline editing** — double-click any cell (except the primary key) to edit its value. Press Enter to save (`UPDATE` via CLI), Escape to cancel. Visual flash confirms the save
- Results shown in a formatted table with sticky headers, hover highlighting, and NULL styling
- Supports MySQL and PostgreSQL

### Laravel Route List
Accessible from the sidebar action bar or View menu. Executes `php artisan route:list --json` and displays:
- All routes in a formatted table with Method, URI, Name, and Action columns
- Color-coded method badges: GET (green), POST (blue), PUT/PATCH (yellow), DELETE (red)
- Click on a controller action to open the PHP file directly (PSR-4 namespace-to-path resolution)

### Terminal
- **Integrated terminal** powered by xterm.js + node-pty
- Starts in the project root directory and resets when switching projects
- Full color support, clickable URLs, smooth scrolling
- Auto-resizes with the editor layout

### Git Integration
- **Source Control panel** — staged, unstaged, and untracked files with one-click stage/unstage/discard
- **Commit** directly from the sidebar
- **Push / Pull** — buttons in the git panel with visual feedback (syncing state and error messages)
- **Git Graph** — SVG visualization of commit history, branches, and tags
- **Diff view** — opens when clicking files in the git panel

### UI & Navigation
- **Sidebar action bar** with quick access to Search, Terminal, Git, Database, and Routes
- **File tree** with lazy-loading and material file icons
- **Collapsible sidebar sections** — outline fills available space when file tree is collapsed
- **Error Log** — captures `console.error`, unhandled errors, and rejected promises. Red badge in status bar, dedicated tab with clear button
- **System monitor** — CPU and RAM usage in the status bar

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+O` | Open folder |
| `Cmd+Shift+O` | Open file |
| `Cmd+P` | Quick Open (fuzzy file search) |
| `Cmd+T` | Go to Symbol (fuzzy symbol search) |
| `Cmd+Shift+F` | Search in Files |
| `Cmd+S` | Save file |
| `Cmd+Shift+S` | Save As |
| `Cmd+W` | Close active tab |
| `Cmd+B` | Toggle sidebar |
| `Cmd+`` ` | Toggle terminal |
| `Cmd+H` | Find & Replace |
| `Cmd+D` | Add selection to next match (multi-cursor) |

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Git** in PATH
- **Build tools** for your OS:
  - **macOS**: `xcode-select --install`
  - **Windows**: Visual Studio Build Tools
  - **Linux**: `sudo apt install build-essential`
- **Optional** (for Database Viewer): `mysql` and/or `psql` CLI clients in PATH

### Install

```bash
git clone https://github.com/mojaveware/mojavecode-php.git
cd mojavecode-php
npm install

# Recompile node-pty for Electron
npx electron-rebuild
```

> `node-pty` is a native C/C++ module. If the rebuild fails, try `npm rebuild node-pty`. The editor works without it, but the terminal won't be able to run real shell commands.

### Run (development)

```bash
npm run dev
```

### Run (production mode)

```bash
npm start
```

### Build distributable

```bash
npm run build          # Current platform
npm run build:mac      # macOS (.dmg)
npm run build:win      # Windows (.exe)
npm run build:linux    # Linux (.AppImage)
```

Outputs go to `dist/`.

---

## Project Structure

```
mojavecode-php/
├── src/
│   ├── main/                        # Electron main process (Node.js)
│   │   ├── main.js                  # Window, menus, IPC, pty, git, composer, artisan, db, search
│   │   ├── preload.js               # Secure context bridge (renderer <-> main)
│   │   └── lsp-manager.js           # Intelephense lifecycle (JSON-RPC 2.0 over stdio)
│   │
│   └── renderer/                    # Electron renderer process (Chromium)
│       ├── index.html               # App shell: titlebar, sidebar, editor area, dialogs, statusbar
│       ├── renderer.js              # UI logic, state management, all feature panels
│       ├── lsp-client.js            # Monaco <-> LSP providers, Blade snippets, PHP smart snippets
│       └── styles/
│           └── editor.css           # Design system with CSS variables (dark + light themes)
│
├── package.json
└── README.md
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     ELECTRON APP                          │
│                                                           │
│  ┌────────────────────┐  IPC  ┌────────────────────────┐ │
│  │   Main Process     │<----->│   Renderer Process     │ │
│  │    (Node.js)       │       │    (Chromium)           │ │
│  │                    │       │                         │ │
│  │ - Filesystem       │       │ - Monaco Editor        │ │
│  │ - node-pty         │       │ - xterm.js             │ │
│  │ - Git (execFile)   │       │ - File Tree & Outline  │ │
│  │ - LSP manager      │       │ - Tab Manager          │ │
│  │ - Native menus     │       │ - Git Panel & Graph    │ │
│  │ - Composer/Artisan │       │ - Search (files/symbols)│ │
│  │ - DB queries (CLI) │       │ - Quick Open           │ │
│  │ - PHPUnit/Pint     │       │ - DB Viewer            │ │
│  │ - PSR-4 resolver   │       │ - Route List           │ │
│  │ - Search engine    │       │ - Theme Switcher       │ │
│  │ - Dialogs          │       │ - Error Log            │ │
│  └────────────────────┘       └────────────────────────┘ │
│          │                              │                 │
│          └──── preload.js (secure bridge) ────┘           │
└──────────────────────────────────────────────────────────┘
```

### Main Process (`main.js`)

Runs in Node.js. Handles everything that needs OS-level access:

- **Window management** — frameless BrowserWindow with custom titlebar
- **Dynamic native menus** — File, Edit, View, Terminal, Composer (if detected), Artisan (if detected, with Modules support), PHP (format on save + PHPUnit), Tema, Help
- **Project detection** — scans the opened folder for `composer.json`, `artisan`, `pint.json`, `.php-cs-fixer.php`, `phpunit.xml`, and `nwidart/laravel-modules`. Rebuilds menus dynamically based on what's found
- **IPC handlers** — filesystem, git (via `execFile`, safe from injection), PTY management, LSP lifecycle, search engine, symbol extraction, Composer/Artisan command execution, database queries, route list, PSR-4 namespace resolution, PHP formatting, PHPUnit execution, CPU monitoring, theme sync
- **Database access** — parses `.env` for credentials, queries via `mysql`/`psql` CLI (no npm database drivers needed)

### Preload (`preload.js`)

Secure bridge via `contextBridge.exposeInMainWorld`. Every IPC channel is explicitly whitelisted — no wildcards. `nodeIntegration: false`, `contextIsolation: true`.

### Renderer (`renderer.js`)

Single-page application with centralized mutable state. Organized in numbered sections covering editor initialization, terminal, file tree, tabs, save, language detection, UI toggles, git panel, theme switching, error log, quick open, search panel, symbol search, database viewer, route list, Composer/Artisan integration, PHP tools, and system monitoring.

### LSP Client (`lsp-client.js`)

Connects Monaco to Intelephense with providers for completion, hover, definition, signature help, and diagnostics. Also registers Blade directive completions (60+ snippets, only in `.blade.php` files) and context-aware PHP smart snippets that detect whether the cursor is inside a class or at the top level.

### Theming

CSS variables in `[data-theme="dark"]` / `[data-theme="light"]`. Theme switching is instant — updates CSS vars, Monaco theme, and native menu radio buttons in one pass. Persisted in `localStorage`.

Colors derived from the MojaveWare brand:
- **Dark**: deep blues (`#0d1a2a`, `#112240`) + sunset orange (`#E85324`) + sand text (`#F4E2CE`)
- **Light**: warm sand (`#FEFAF7`, `#F4E2CE`) + deep blue text (`#1F4266`) + same accent orange

---

## Security

- `nodeIntegration: false`, `contextIsolation: true`
- All IPC channels explicitly exposed via preload (no wildcard patterns)
- Git commands use `execFile` with args array (no shell interpolation)
- Database queries sanitize table/column names to alphanumeric + underscore only
- Terminal `cd` uses shell-safe quoting via dedicated `pty:cd` handler
- File walk capped at 5,000 files / 15 levels deep to prevent resource exhaustion
- `sandbox: false` is required for node-pty (documented trade-off)

---

## Tech Stack

| Component | Library | Purpose |
|---|---|---|
| Framework | Electron 33 | Desktop app shell |
| Editor | Monaco Editor 0.52 | Code editing, syntax highlighting, diff |
| Terminal | xterm.js 5.5 | Terminal emulator |
| PTY | node-pty 1.0 | Real shell backend |
| LSP | Intelephense 1.16 | PHP language server |
| Icons | material-file-icons 2.4 | File tree icons |
| Build | electron-builder 25 | Packaging and distribution |

No additional runtime dependencies for database access (uses `mysql`/`psql` CLI) or PHP tooling (uses `composer`, `php`, `vendor/bin/*` from the project).

---

## Known Limitations

- LSP only supports PHP (Intelephense). Other languages get syntax highlighting but no autocomplete or diagnostics
- No file watcher — external file changes aren't detected until the file is reopened
- No settings UI — font size, tab size, and other preferences are hardcoded
- Single window only
- Database viewer requires `mysql` or `psql` CLI installed locally
- No Xdebug integration (breakpoints/debugging)

---

## Roadmap

### Planned
- [ ] Xdebug integration (breakpoints and step debugging)
- [ ] `.env` viewer with syntax highlighting and hidden secrets
- [ ] Docker-aware command execution (run Composer/Artisan/PHPUnit inside containers)
- [ ] File watcher for external changes
- [ ] Settings/preferences UI
- [ ] Multiple windows

---

## License

MIT — MojaveWare
