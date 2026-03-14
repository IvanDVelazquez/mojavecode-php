# MojaveCode PHP

A lightweight code editor built for PHP developers by **[MojaveWare](https://mojaveware.com)**.

Built with Electron, Monaco Editor (the engine behind VS Code), and xterm.js. Comes with Intelephense LSP out of the box — autocomplete, go-to-definition, diagnostics, and signature help for PHP without installing a single extension. Two themes inspired by the Mojave desert palette.

---

## Features

### PHP First
- **Intelephense LSP** built-in — autocomplete, go-to-definition, hover docs, signature help, real-time diagnostics
- **Blade syntax highlighting** with directive snippets
- No extensions needed — works out of the box for PHP/Laravel projects

### Editor
- **Monaco Editor** with syntax highlighting for 30+ languages
- **Two themes**: Mojave Dark (deep blues + sunset orange) and Mojave Light (warm sand + deep blue), switchable from the native menu bar
- **Tab management** with unsaved changes warnings on close
- **Diff view** (side-by-side, read-only) for staged and unstaged git changes
- **Find & Replace** (`Cmd+H`)
- **Quick Open** (`Cmd+P`) with fuzzy file search across the project

### Terminal
- **Integrated terminal** powered by xterm.js + node-pty
- Full color support, clickable URLs, smooth scrolling
- Auto-resizes with the editor layout

### Git Integration
- **Source Control panel** with staged, unstaged, and untracked files
- Stage, unstage, discard changes with one click
- **Commit** directly from the sidebar
- **Git Graph** tab with SVG visualization of commit history, branches, and tags
- **Diff view** opens when clicking files in the git panel

### Sidebar
- **File tree** with lazy-loading (only loads folder contents on expand)
- **Outline panel** showing classes, methods, functions, constants, and variables — grouped by kind with collapsible sections
- Collapsible sections — outline fills available space when file tree is collapsed

### Developer Tools
- **Error Log** captures `console.error`, unhandled errors, and rejected promises. Red badge in status bar, dedicated tab with clear button
- **System monitor** in status bar showing CPU and RAM usage per instance

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+O` | Open folder |
| `Cmd+P` | Quick Open (fuzzy file search) |
| `Cmd+S` | Save file |
| `Cmd+W` | Close active tab |
| `Cmd+B` | Toggle sidebar |
| `Cmd+`` ` | Toggle terminal |
| `Cmd+H` | Find & Replace |

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Git** installed and in PATH
- **Build tools** del SO:
  - **macOS**: `xcode-select --install`
  - **Windows**: Visual Studio Build Tools
  - **Linux**: `sudo apt install build-essential`

### Install

```bash
git clone https://github.com/mojaveware/mojavecode-php.git
cd mojavecode-php
npm install

# Recompile node-pty for Electron
npx electron-rebuild
```

> `node-pty` is a native C/C++ module. If it fails, try `npm rebuild node-pty` or reinstall it. The editor works without it but the terminal won't run real commands.

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
│   │   ├── main.js                  # Window, menus, IPC handlers, pty, git
│   │   ├── preload.js               # Context bridge (renderer <-> main API)
│   │   └── lsp-manager.js           # LSP client over stdio (JSON-RPC 2.0)
│   │
│   └── renderer/                    # Electron renderer process (Chromium)
│       ├── index.html               # App shell: titlebar, sidebar, editor area, statusbar
│       ├── renderer.js              # All UI logic, state, and features
│       ├── lsp-client.js            # Monaco <-> LSP integration
│       └── styles/
│           └── editor.css           # Full design system with CSS variables
│
├── package.json
└── README.md
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  ELECTRON APP                     │
│                                                   │
│  ┌───────────────┐  IPC   ┌────────────────────┐ │
│  │ Main Process  │<------>│ Renderer Process    │ │
│  │  (Node.js)    │        │  (Chromium)         │ │
│  │               │        │                     │ │
│  │ - filesystem  │        │ - Monaco Editor     │ │
│  │ - node-pty    │        │ - xterm.js          │ │
│  │ - git (exec)  │        │ - File Tree         │ │
│  │ - LSP manager │        │ - Tab Manager       │ │
│  │ - native menu │        │ - Git Panel/Graph   │ │
│  │ - dialogs     │        │ - Outline           │ │
│  └───────────────┘        │ - Quick Open        │ │
│          │                └────────────────────┘ │
│          └── preload.js (secure bridge) ─┘       │
└──────────────────────────────────────────────────┘
```

### Main Process (`main.js`)

Runs in Node.js. Manages:

- **Window**: frameless BrowserWindow with custom titlebar
- **Native menu**: File, Edit, View, Terminal, Tema (theme switcher), Help
- **IPC handlers**: filesystem ops, git commands, LSP lifecycle, CPU monitor, theme sync
- **PTY**: spawns a real shell via node-pty, pipes data bidirectionally with xterm.js
- **Git**: all commands use `execFile` with args array (prevents command injection)

### Preload (`preload.js`)

Bridges main and renderer via `contextBridge.exposeInMainWorld`. No `nodeIntegration`, full `contextIsolation`. Every IPC channel is explicitly whitelisted.

### Renderer (`renderer.js`)

Single-page app organized in numbered sections:

| # | Section | What it does |
|---|---|---|
| 1 | **Editor** | Monaco init, dark/light themes, keybindings |
| 2 | **Terminal** | xterm.js setup, pty connection, resize observer |
| 3 | **File Tree** | Lazy-loaded directory tree with material icons |
| 4 | **Tab Manager** | Open/close/activate, unsaved warnings, special tabs |
| 5 | **File Save** | Write to disk via IPC, sync modified state |
| 6 | **Language Detection** | Extension to Monaco language + display name mapping |
| 7 | **UI Toggles** | Sidebar/terminal toggle, diff view, git graph, outline |
| 8 | **Git Panel** | Stage/unstage/discard/commit with event delegation |
| 8b | **Theme Switcher** | CSS vars + Monaco + localStorage + native menu sync |
| 8c | **Error Log** | Intercepts console.error and unhandled errors |
| 8d | **Quick Open** | Fuzzy file search with keyboard navigation |
| 9 | **Events & Init** | Wiring, keyboard shortcuts, app bootstrap |

### Theming

CSS variables in `[data-theme="dark"]` / `[data-theme="light"]`. Theme switch is instant — updates CSS vars + Monaco theme + syncs native menu radio buttons. Persisted in `localStorage`.

Colors derived from the MojaveWare brand icon:
- **Dark**: deep blues (#0d1a2a, #112240) + sunset orange (#E85324) + sand text (#F4E2CE)
- **Light**: warm sand (#FEFAF7, #F4E2CE) + deep blue text (#1F4266) + same accent orange

### LSP

PHP support via Intelephense, managed through `LspManager` (stdio transport, JSON-RPC 2.0 framing):
- Autocomplete with documentation
- Go to definition
- Hover information
- Signature help
- Real-time diagnostics

---

## Security

- `nodeIntegration: false`, `contextIsolation: true`
- All IPC channels explicitly exposed via preload (no wildcard)
- Git commands use `execFile` with args array (no shell interpolation)
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

---

## Known Limitations (v0.1.0)

- LSP only supports PHP (Intelephense). Other languages get syntax highlighting but no autocomplete/diagnostics
- No project-wide search (`Cmd+Shift+F`)
- No git push/pull/branch management (only local staging and commits)
- No file watcher — external file changes aren't detected until file is reopened
- No settings UI — font size, tab size, and other preferences are hardcoded
- No formatter on save (PHP CS Fixer / Pint)
- Single window only

---

## Roadmap

### Next up
- [ ] Project-wide search (`Cmd+Shift+F`)
- [ ] Git push/pull
- [ ] Terminal opens in project root directory
- [ ] PHP CS Fixer / Pint on save

### Planned
- [ ] Artisan runner (Laravel command palette)
- [ ] Composer integration (require, install, dump-autoload)
- [ ] PHPUnit test runner (run test at cursor)
- [ ] Go to Symbol in project (`Cmd+T`)
- [ ] File watcher for external changes
- [ ] Settings/preferences UI

### Future
- [ ] Xdebug integration (breakpoints)
- [ ] Database viewer (read .env, show tables)
- [ ] Laravel route list panel
- [ ] Docker-aware command execution
- [ ] .env viewer with hidden secrets

---

## License

MIT — MojaveWare
