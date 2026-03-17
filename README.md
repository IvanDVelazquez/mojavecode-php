# MojaveCode PHP

A lightweight, batteries-included code editor built for PHP developers by **[MojaveWare](https://mojaveware.com)**.

MojaveCode is designed to fill the gap between heavy IDEs like PHPStorm and generic editors like VS Code that need dozens of extensions to be useful for PHP. It ships with everything a PHP/Laravel developer needs out of the box: an LSP, a terminal, git integration, Composer, Artisan, PHPUnit, a database viewer, and more — all wrapped in a fast Electron shell with a custom Mojave-inspired design.

Built with Electron, Monaco Editor, and xterm.js.

---

## Getting Started

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Git** in PATH
- **Optional** (for Database Viewer): `mysql` and/or `psql` CLI clients in PATH

### Clone and Install

```bash
git clone https://github.com/mojaveware/mojavecode-php.git
cd mojavecode-php
npm install
```

### Rebuild native modules

`node-pty` is a C/C++ native module that must be compiled against Electron's version of Node.js. If you skip this step the terminal won't work.

```bash
npx electron-rebuild
```

If it fails, try `npm rebuild node-pty`. The editor still launches without it, but the integrated terminal won't be able to run real shell commands.

### Run in development

```bash
npm run dev
```

### Run in production mode

```bash
npm start
```

---

## Building for Distribution

MojaveCode uses **electron-builder** to package the app. Distributables are output to the `dist/` folder.

### Build for your current platform

```bash
npm run build
```

This auto-detects your OS and creates the appropriate package.

### macOS (.dmg)

**Requirements:**
- macOS (cross-compilation from other platforms is not supported by Apple)
- Xcode Command Line Tools: `xcode-select --install`

```bash
npm run build:mac
```

Output: `dist/MojaveCode PHP-<version>.dmg`

To install, open the `.dmg` and drag MojaveCode PHP to the Applications folder. On first launch macOS may ask you to allow it in System Settings > Privacy & Security since the app is not notarized.

> **Code signing & notarization (optional):** To distribute outside your machine, you need an Apple Developer account. Set the `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables with your `.p12` certificate, and add `"notarize": true` to the `mac` section in `package.json`. See the [electron-builder docs](https://www.electron.build/code-signing) for details.

### Windows (.exe installer)

**Requirements:**
- Windows 10/11 (or cross-compile from macOS/Linux using Wine — not recommended)
- Visual Studio Build Tools (for `node-pty` compilation): download from [visualstudio.microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and install the "Desktop development with C++" workload

```bash
npm run build:win
```

Output: `dist/MojaveCode PHP Setup <version>.exe`

The installer is built with NSIS. Run the `.exe` to install — it creates a Start Menu shortcut and an uninstaller in Add/Remove Programs. Windows Defender SmartScreen may show a warning since the app is not code-signed.

> **Code signing (optional):** To avoid SmartScreen warnings, sign the executable with an EV or standard code signing certificate. Set `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables before building. See the [electron-builder docs](https://www.electron.build/code-signing).

### Linux (.AppImage)

**Requirements:**
- A Debian/Ubuntu-based distro (or any distro with `glibc >= 2.31`)
- Build essentials: `sudo apt install build-essential libx11-dev libxkbfile-dev`

```bash
npm run build:linux
```

Output: `dist/MojaveCode PHP-<version>.AppImage`

To run:

```bash
chmod +x "dist/MojaveCode PHP-<version>.AppImage"
./"dist/MojaveCode PHP-<version>.AppImage"
```

AppImage is a portable format — no installation needed. For desktop integration (app launcher icon), use [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher) or move the file to `~/Applications/` and create a `.desktop` entry manually.

> **Alternative targets:** You can change the Linux target in `package.json` under `build.linux.target` to `deb`, `rpm`, or `snap` if you prefer a native package format.

### Cross-compilation notes

| Building on | macOS | Windows | Linux |
|---|---|---|---|
| **macOS** | native | not supported | not supported |
| **Windows** | not supported | native | not supported |
| **Linux** | not supported | not supported | native |

Electron-builder technically supports some cross-compilation scenarios, but `node-pty` (native C++ module) must be compiled for the target OS. The most reliable approach is to build on each platform natively, or use CI (GitHub Actions) with a matrix of `macos-latest`, `windows-latest`, and `ubuntu-latest` runners.

---

## Features

### Editor Core
- **Monaco Editor** — the same engine behind VS Code, with syntax highlighting for 30+ languages
- **Themes** — Mojave Dark and Mojave Light built-in, plus a **theme generator** to create unlimited custom themes from 3 colors (background, accent, text). Custom themes are persisted across sessions and appear in the native menu bar
- **Tab management** — unsaved change warnings, modified indicators, **drag & drop reordering**, multiple special tabs (terminal, git graph, diff, output, database, routes, logs)
- **Diff view** — side-by-side comparison for staged and unstaged git changes
- **Zoom** (`Cmd+=` / `Cmd+-` / `Cmd+0`) — adjusts editor font size from 8px to 40px with proportional line height. Percentage indicator in the status bar (click to reset). Persisted across sessions via localStorage
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
The Composer menu is always visible in the menu bar. Project-specific commands appear when `composer.json` is detected:
- **New Laravel Project...** — always available. Creates a new Laravel project with `composer create-project`: prompts for the project name, lets you choose the destination folder, runs the installation (with 10-minute timeout for slow connections), and opens the new project automatically on completion
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
- **Multi-database support** — auto-detects all database connections in the `.env` file. Supports `DB_DATABASE` (default), `DB_{PREFIX}_DATABASE` (e.g. `DB_ADMIN_DATABASE`), and `DB_DATABASE_{SUFFIX}` (e.g. `DB_DATABASE_BLOG`). Each database is shown as a collapsible section with its own connection info and table count. Per-connection credentials are resolved automatically (e.g. `DB_ADMIN_HOST`, `DB_ADMIN_USERNAME`) with fallback to the default credentials
- Shows all tables with expandable columns (name, type, nullable, primary/foreign key indicators)
- **Query panel** per table — select a column, pick an operator (`=`, `LIKE`, `IS NULL`, etc.), enter a value, and search. Or load all rows with one click
- **Inline editing** — double-click any cell (except the primary key) to edit its value. Press Enter to save (`UPDATE` via CLI), Escape to cancel. Visual flash confirms the save
- Results shown in a formatted table with sticky headers, hover highlighting, and NULL styling
- Table search (`Cmd+F`) filters across all databases — sections without matches are hidden automatically
- Supports MySQL and PostgreSQL

### Laravel Route List
Accessible from the sidebar action bar or View menu. Executes `php artisan route:list --json` and displays:
- All routes in a formatted table with Method, URI, Name, and Action columns
- Color-coded method badges: GET (green), POST (blue), PUT/PATCH (yellow), DELETE (red)
- Click on a controller action to open the PHP file directly (PSR-4 namespace-to-path resolution)

### Log Viewer
Accessible from the sidebar action bar. Reads all log files from `storage/logs` (not just `laravel.log`):
- **Sidebar panel** — replaces the file tree (same pattern as Git and Search panels), lists all log files sorted by name
- **Formatted view** — parses Laravel log format (`[timestamp] env.LEVEL: message`) into structured, color-coded entries
- **Log level badges** — ERROR (red), WARNING (yellow), INFO (blue), DEBUG (gray)
- **Collapsible stack traces** — click the toggle arrow to expand/collapse
- **JSON pretty-printing** — embedded JSON objects in log messages are automatically detected and formatted with indentation
- **Level filters** — filter by All, Error, Warning, Info, or Debug with one click
- **Full-text search** — real-time filtering with highlighted matches across messages and stack traces. Combines with level filters
- **Refresh button** — reload the current log without closing the tab

### Terminal
- **Integrated terminal** powered by xterm.js + node-pty
- Starts in the project root directory and resets when switching projects
- Full color support, clickable URLs, smooth scrolling
- Auto-resizes with the editor layout
- **Clean session lifecycle** — closing the terminal tab kills the underlying pty process; reopening always spawns a fresh shell with a clean environment

### Claude Code Integration
A sidebar panel (lightbulb icon in the action bar) that reads the project's `.claude/` directory and surfaces your custom Claude Code extensions:

- **SKILLS** — displays custom skills from `.claude/skills/*/SKILL.md` and slash commands from `.claude/commands/*.md`. Each entry shows its name and up to 5 lines of description
- **AGENTS** — displays custom agents from `.claude/agents/*.md` with their model and color indicator
- **Directory walk-up** — automatically finds the `.claude/` directory by climbing the filesystem from the current project folder, so nested sub-projects are handled correctly
- **Detail dashboard** — click any skill, command, or agent to open a dedicated tab with the full rendered Markdown content, type/model/version badges, and a chip list of declared tools
- Frontmatter fields parsed: `name`, `description`, `model`, `version`, `tools`, `color`

### Git Integration
- **Source Control panel** — staged, unstaged, and untracked files with one-click stage/unstage/discard
- **Commit** directly from the sidebar
- **Push / Pull** — buttons in the git panel with visual feedback (syncing state and error messages)
- **Branch picker** (`Cmd+Shift+B`) — command palette-style branch switcher with instant search. Shows local and remote branches, with the current branch and main/master always at the top. Also accessible by clicking the branch name in the status bar. Remote-only branches are marked and automatically create a local tracking branch on checkout
- **Auto-refresh branch** — the status bar branch name and git panel update automatically when you run git commands (checkout, switch, etc.) in the integrated terminal
- **Status bar sync** — Pull (↓) and Push (↑) buttons next to the branch name in the status bar for quick one-click sync, with spin animation while executing
- **Git Graph** — SVG visualization of commit history, branches, and tags
- **Diff view** — opens when clicking files in the git panel

### UI & Navigation
- **Sidebar action bar** with quick access to Search, Terminal, Git, Database, Routes, Logs, and Claude Code integration
- **File tree** with lazy-loading, material file icons, **auto-reveal** (activating a tab expands and scrolls to the file in the tree, like VS Code's "Reveal in Side Bar"), and **right-click context menu** (Copy Path, Copy, Paste, Delete)
- **Resizable sidebar** — drag the right edge to adjust width (150px–600px)
- **Breadcrumb bar** — shows the relative path of the active file between the tab bar and the editor, making it easy to distinguish files with the same name in different directories
- **Collapsible sidebar sections** — outline fills available space when file tree is collapsed
- **Recent folders** — last 5 opened folders shown on the welcome screen for one-click access, and in File > Open Recent in the native menu bar. Persisted across sessions
- **Auto Save** — toggle from File > Auto Save. Saves automatically 1 second after the last keystroke
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
| `Cmd+Shift+B` | Switch Git branch |
| `Cmd+B` | Toggle sidebar |
| `Cmd+`` ` | Toggle terminal |
| `Cmd+H` | Find & Replace |
| `Cmd+=` | Zoom in |
| `Cmd+-` | Zoom out |
| `Cmd+0` | Reset zoom |
| `Cmd+D` | Add selection to next match (multi-cursor) |

---

## Project Structure

```
mojavecode-php/
├── src/
│   ├── main/                        # Electron main process (Node.js)
│   │   ├── main.js                  # Window, menus, IPC, pty, git, composer, artisan, db, search
│   │   ├── preload.js               # Secure context bridge (renderer <-> main)
│   │   ├── lsp-manager.js           # Intelephense lifecycle (JSON-RPC 2.0 over stdio)
│   │   └── db-helper.js             # .env parsing, multi-database detection, SQL execution via CLI
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
│  │ - Log reader       │       │ - Log Viewer           │ │
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
- **Dynamic native menus** — File, Edit, View, Terminal, Git, Composer (always visible, project commands conditional), Artisan (if detected, with Modules support), PHP (format on save + PHPUnit), Tema, Help
- **Project detection** — scans the opened folder for `composer.json`, `artisan`, `pint.json`, `.php-cs-fixer.php`, `phpunit.xml`, and `nwidart/laravel-modules`. Rebuilds menus dynamically based on what's found
- **IPC handlers** — filesystem (read, write, delete, copy), git (via `execFile`, safe from injection), PTY management, LSP lifecycle, search engine, symbol extraction, Composer/Artisan command execution, database queries, route list, log file reading, PSR-4 namespace resolution, PHP formatting, PHPUnit execution, CPU monitoring, auto-save, theme sync
- **Database access** — parses `.env` for credentials (auto-detects multiple database connections), queries via `mysql`/`psql` CLI (no npm database drivers needed)

### Preload (`preload.js`)

Secure bridge via `contextBridge.exposeInMainWorld`. Every IPC channel is explicitly whitelisted — no wildcards. `nodeIntegration: false`, `contextIsolation: true`.

### Renderer (`renderer.js`)

Single-page application with centralized mutable state. Organized in numbered sections covering editor initialization, terminal (with auto git branch refresh and clean pty lifecycle), file tree (with context menu and auto-reveal), tabs (with drag & drop reordering), save (with auto-save), breadcrumb bar, language detection, UI toggles (sidebar resize), git panel, branch picker (command palette-style branch switcher), theme switching and custom theme generator (color derivation engine with live preview), error log, quick open, search panel, symbol search, database viewer, route list, log viewer (formatted with search and filters), Composer/Artisan integration (including New Laravel Project), PHP tools, system monitoring, and Claude Code integration panel (skills, commands, agents with detail dashboard).

### LSP Client (`lsp-client.js`)

Connects Monaco to Intelephense with providers for completion, hover, definition, signature help, and diagnostics. Also registers Blade directive completions (60+ snippets, only in `.blade.php` files) and context-aware PHP smart snippets that detect whether the cursor is inside a class or at the top level.

### Theming

CSS variables in `[data-theme="dark"]` / `[data-theme="light"]`. Theme switching is instant — updates CSS vars, Monaco theme, terminal ANSI colors, and native menu radio buttons in one pass. Persisted in `localStorage`.

Colors derived from the MojaveWare brand:
- **Dark**: deep blues (`#0d1a2a`, `#112240`) + sunset orange (`#E85324`) + sand text (`#F4E2CE`)
- **Light**: warm sand (`#FEFAF7`, `#F4E2CE`) + deep blue text (`#1F4266`) + same accent orange

**Theme Generator** (`Tema > Generate Theme...`): create custom themes from 3 input colors:
- **Background** — ~10 variants derived automatically (darkest, panel, sidebar, hover, active, tabs, terminal, border) using lightness adjustments
- **Accent** — syntax highlighting colors generated via hue rotation (+40 numbers, +100 strings, +130 tags, +160 functions, +220 variables). UI colors (red, green, blue, yellow, teal) also derived
- **Text** — primary/secondary/muted derived by mixing with background at different ratios
- Auto-detects dark vs light based on background luminance (ITU-R BT.601)
- Generates a complete Monaco editor theme (11 token rules + 15 editor colors) and terminal theme (16 ANSI colors)
- Live mini-preview updates as you pick colors
- Custom themes are saved in `localStorage`, appear in the native Tema menu, and can be deleted from `Tema > Delete Theme`

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
- No settings UI — tab size and other preferences are hardcoded (font size is adjustable via zoom)
- Database viewer requires `mysql` or `psql` CLI installed locally
- No Xdebug integration (breakpoints/debugging)

---

## Roadmap

### Planned
- [ ] Xdebug integration (breakpoints and step debugging)
- [ ] `.env` viewer with syntax highlighting and hidden secrets
- [ ] File watcher for external changes
- [ ] Settings/preferences UI
- [ ] Multiple terminal instances

---

## License

MIT — MojaveWare
