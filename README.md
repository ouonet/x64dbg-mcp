# x64dbg MCP Server

A production-level [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **x64dbg** reverse-engineering and debugging capabilities to AI assistants (Claude, Windsurf Cascade, Cursor, etc.).

## Architecture

```
┌─────────────────┐  STDIO/JSON-RPC   ┌──────────────────┐  TCP (JSON)  ┌──────────────┐
│  AI Assistant    │ ◄───────────────► │  MCP Server      │ ◄──────────► │  x64dbg      │
│  (Claude, etc.)  │                   │  (Node.js / TS)  │   port 27042 │  + Bridge    │
└─────────────────┘                    └──────────────────┘              │    Plugin    │
                                                                         └──────────────┘
```

**Two components:**

1. **MCP Server** (`src/`) — TypeScript Node.js process. Speaks MCP over STDIO to the AI host and connects to the bridge over TCP.
2. **Bridge Plugin** (`plugin/`) — A lightweight C loader plugin embeds Python 3.10+ inside x64dbg. The Python bridge script calls `x64bridge.dll` directly via `ctypes` — **no x64dbgpy dependency**. Exposes a local TCP server that translates MCP requests into x64dbg Bridge SDK calls.

## Features

### Auto-Launch & PE Detection
- Automatically detects PE architecture (x86 / x64) by reading the PE header
- Launches the correct debugger variant (`x32dbg` or `x64dbg`) with the target executable
- Waits for the bridge plugin TCP port to become reachable, then connects — **zero manual setup**

### Core Debugging (15 tools)
- `load_executable` — Load PE file, **auto-detect x86/x64, auto-launch debugger**, break on entry
- `continue_execution` / `step_into` / `step_over` / `step_out`
- `run_to_address` — Run until a specific address
- `set_breakpoint` — Software, hardware (execute/read/write/access), and memory BPs with conditions and log text
- `remove_breakpoint` / `list_breakpoints`
- `terminate_session` / `list_sessions`
- `get_status` — Query bridge connectivity, session state, current IP, and next-step hint
- `close_debugger` — Kill the x64dbg/x32dbg process (works even if bridge is disconnected)
- `collect_bp_args` — Loop through breakpoint hits and collect a memory expression at each hit
- `execute_command` — Run any raw x64dbg command

### Memory & Registers (9 tools)
- `read_memory` / `write_memory` / `search_memory` — Hex patterns with wildcards, ASCII/Unicode text
- `get_memory_map` — Full virtual memory layout with protection and module info
- `get_registers` / `set_register` — GP, flags, segment, debug, FPU/SSE registers
- `get_call_stack` — Backtrace with return addresses, module names, and symbols
- `get_threads` / `switch_thread` — Thread enumeration and context switching

### Static & Dynamic Analysis (10 tools)
- `disassemble` — With metadata (is_call, is_jump, reference targets, comments)
- `analyze_function` — Boundaries, size, call graph (callers + callees), leaf detection
- `get_cross_references` — Code and data xrefs (to/from/both)
- `list_functions` — With module filtering, name search, and pagination
- `get_modules` / `get_imports` / `get_exports` — With DLL and function name filters
- `find_strings` — ASCII + Unicode with content filtering and min-length control
- `get_pe_header` — Full PE structure: DOS/NT headers, sections, data directories, entropy
- `trace_execution` — Record instruction trace with optional register snapshots

### Security Analysis (5 tools)
- `detect_packing` — Entropy analysis, known packer signatures, import count heuristics, confidence scoring
- `analyze_suspicious_apis` — Cross-reference imports against 100+ malware-associated APIs in 10 categories
- `detect_anti_debug` — IsDebuggerPresent, timing checks, PEB flags, TLS callbacks, int 2D/3, with bypass suggestions
- `check_section_anomalies` — W+X sections, unusual names, zero raw-size, high entropy detection
- `generate_security_report` — Consolidated first-pass triage of all security checks with overall risk level

**Total: 39 tools**

## Prerequisites

- **Windows** (x64dbg is Windows-only)
- **Node.js** ≥ 20
- **Python 3.10+** installed system-wide
- **CMake 3.15+** + MSVC or MinGW — only needed to build the C loader from source (pre-built binaries are included in the npm package)

> x64dbg itself is **downloaded automatically** by `npm install` if not already present.

## Installation

### From npm (recommended)

```bash
npm install -g x64dbg-mcp
```

`postinstall` runs automatically and handles:

| Step | What happens |
|------|-------------|
| x64dbg | Downloads latest snapshot from GitHub if not found locally |
| Plugin files | Deploys `.dp64` / `.dp32` loader + Python bridge to x64dbg plugins/ |
| Bridge auth | Generates a random `BRIDGE_AUTH_TOKEN` and writes `x64dbg_mcp_bridge.token` to plugins/ |
| Python | Detects Python install dir, sets `PYTHON_HOME_X64` / `PYTHON_HOME_X86` |
| `.env` | Creates with all detected settings and defaults |

After install, only two manual steps remain:

```bash
npm run doctor        # verify everything is in order
# then configure your AI client (see Usage section)
```

### From source

```bash
git clone https://github.com/your-org/x64dbg-mcp
cd x64dbg-mcp
npm install           # downloads x64dbg, deploys .py files, writes .env
npm run build         # compile TypeScript → dist/
npm run install-plugin  # compile C loader (x64+x32), deploy to x64dbg
npm run doctor        # verify
```

> **x64dbg already installed elsewhere?** Set `X64DBG_PATH` in `.env` before running
> `npm run install-plugin`, or pass `-X64dbgPath "C:\path\to\x64dbg"` to the script.

### Manual plugin installation (alternative to `install-plugin`)

```powershell
cd plugin\loader

# 64-bit
cmake -B build64 -A x64
cmake --build build64 --config Release
$p64 = "C:\x64dbg\release\x64\plugins"
Copy-Item build64\Release\x64dbg_mcp_loader.dp64 $p64
Copy-Item ..\x64dbg_mcp_bridge.py                $p64
Copy-Item ..\x64dbg_bridge_sdk.py                $p64

# 32-bit
cmake -B build32 -A Win32 -DBUILD_32BIT=ON
cmake --build build32 --config Release
$p32 = "C:\x64dbg\release\x32\plugins"
Copy-Item build32\Release\x64dbg_mcp_loader.dp32 $p32
Copy-Item ..\x64dbg_mcp_bridge.py                $p32
Copy-Item ..\x64dbg_bridge_sdk.py                $p32
```

`npm run install-plugin` does all of the above (both architectures by default). Pass `-No32` to skip 32-bit.

## Configuration

`npm install` creates `.env` automatically. To adjust, edit it directly or run `npm run setup` for an interactive wizard.

```env
# x64dbg path (auto-detected)
X64DBG_PATH=C:\x64dbg

# Python install directories — avoids copying DLLs into the plugins folder.
# The C loader checks these first; falls back to PATH if unset.
PYTHON_HOME_X64=C:\Python314
PYTHON_HOME_X86=C:\Python312-32

# Bridge
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=27042
BRIDGE_AUTH_TOKEN=<auto-generated>

# Logging / limits
LOG_LEVEL=info
MAX_SESSIONS=1
SESSION_TIMEOUT_MS=3600000
```

| Variable | Default | Description |
|----------|---------|-------------|
| `X64DBG_PATH` | auto-detected | x64dbg installation directory |
| `PYTHON_HOME_X64` | *(auto-detected)* | Python 64-bit dir — loader Priority 1; no DLL copy needed |
| `PYTHON_HOME_X86` | *(auto-detected)* | Python 32-bit dir — used by `.dp32` loader |
| `BRIDGE_PORT` | `27042` | TCP port the Python bridge listens on |
| `BRIDGE_AUTH_TOKEN` | auto-generated | Shared secret for localhost MCP ↔ bridge requests |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `MAX_SESSIONS` | `1` | Single-session limit for the current x64dbg bridge architecture |
| `SESSION_TIMEOUT_MS` | `3600000` | Session idle timeout (ms) |

The recommended path is to let the MCP server auto-launch x64dbg. If you manually start x64dbg,
keep the deployed `x64dbg_mcp_bridge.token` file in the plugins directory so the bridge can enforce
the same token as the MCP server.

## Usage

### Configure your AI host

> **Note:** You no longer need to manually start x64dbg. The MCP server auto-launches
> the correct debugger when you call `load_executable`.

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x64dbg-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\x64dbg-mcp\\dist\\server.js"]
    }
  }
}
```

#### Windsurf / Cascade

```json
{
  "mcpServers": {
    "x64dbg-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\x64dbg-mcp\\dist\\server.js"],
      "env": { "BRIDGE_PORT": "27042" }
    }
  }
}
```

### Start debugging

Ask your AI assistant:

> "Load C:\samples\target.exe and analyze it for suspicious behavior"

The AI will use the MCP tools to:
1. `load_executable` → load the binary
2. `generate_security_report` → run all security checks
3. `disassemble` → inspect suspicious code
4. `set_breakpoint` + `continue_execution` → dynamic analysis

## Example Workflows

### Crash Analysis
```
User: "My program crashes at startup, help me debug it"
AI:   load_executable → continue_execution → get_call_stack →
      read_memory → get_registers → disassemble
```

### Malware Triage
```
User: "Analyze this suspicious binary"
AI:   load_executable → generate_security_report →
      analyze_suspicious_apis → detect_anti_debug →
      find_strings → get_imports
```

### Reverse Engineering
```
User: "Find the license check function"
AI:   load_executable → find_strings (filter: "license") →
      get_cross_references → analyze_function →
      disassemble → trace_execution
```

## Development

```bash
npm run ci                        # Full local pipeline: build + lint + test + python + C loader
npm run ci -- --no-loader         # Skip C loader (no CMake needed)
npm run dev                       # Sync .py files to bundled x64dbg, then run via tsx
npm run sync-plugin               # Manually sync plugin/*.py → x64dbg/release/x*/plugins/
npm run setup-x64dbg              # Download/update bundled x64dbg snapshot
npm run setup-x64dbg -- --force   # Force re-download
npm run setup-x64dbg -- --tag snapshot_2024-09-10_00-00  # Pin to specific version
npm run build                     # Compile TypeScript → dist/
npm run lint                      # ESLint src/**/*.ts
npm test                          # Unit tests (no x64dbg required)
npm run inspector                 # Launch MCP Inspector UI
npm run clean                     # Remove dist/
```

`npm run dev` automatically syncs Python source files to the bundled x64dbg via the `predev`
hook before starting the server — no manual copy needed during development.

## Testing

```bash
# TypeScript unit tests (SessionManager, BridgeClient, launcher, config)
npm test

# Python bridge offline tests (no x64dbg required)
python plugin/test_bridge.py

# Full environment check
npm run doctor
```

CI (`.github/workflows/ci.yml`) runs all three jobs on every push:
- `ts`: build + lint + test on Node 20 and 22
- `python`: syntax check + logic tests on Python 3.11
- `loader`: CMake build (x64 + x32), artifacts saved to `plugin/loader/prebuilt/`

On tagged releases (`v*`), CI also publishes to npm with the prebuilt binaries included.

## Project Structure

```
x64dbg-mcp/
├── src/
│   ├── server.ts              # Entry point, MCP server, graceful shutdown
│   ├── bridge.ts              # TCP client — reconnect, request/response tracking
│   ├── launcher.ts            # PE arch detection, debugger spawn, bridge poll
│   ├── session.ts             # Session lifecycle & GC
│   ├── config.ts              # Config from env / .env
│   ├── logger.ts              # Winston logger (stderr only)
│   ├── types.ts               # Shared TypeScript types
│   └── tools/
│       ├── index.ts           # Tool registration barrel
│       ├── debug.ts           # Core debugging (12 tools)
│       ├── memory.ts          # Memory & registers (9 tools)
│       ├── analysis.ts        # Analysis (10 tools)
│       └── security.ts        # Security analysis (5 tools)
├── plugin/
│   ├── x64dbg_mcp_bridge.py   # TCP server + handler dispatch
│   ├── x64dbg_bridge_sdk.py   # ctypes bindings to x64bridge.dll
│   ├── test_bridge.py         # Offline unit tests (no x64dbg required)
│   ├── loader/
│   │   ├── x64dbg_mcp_loader.c     # C plugin — embeds Python 3
│   │   ├── CMakeLists.txt
│   │   └── prebuilt/               # Pre-built .dp64/.dp32 (populated by CI)
│   └── README.md
├── scripts/
│   ├── postinstall.mjs        # Runs after npm install — downloads x64dbg, deploys plugin, writes .env
│   ├── setup-x64dbg.mjs       # npm run setup-x64dbg — download/update x64dbg snapshot
│   ├── setup.mjs              # npm run setup — interactive .env wizard
│   ├── doctor.mjs             # npm run doctor — pre-flight diagnostics
│   ├── sync-plugin.mjs        # npm run sync-plugin — sync .py to bundled x64dbg (predev hook)
│   ├── ci.mjs                 # npm run ci — local CI pipeline
│   └── install-plugin.ps1     # npm run install-plugin — compile C loader & deploy
├── test/
│   └── basic.test.ts          # Node.js built-in test runner
├── .github/
│   └── workflows/
│       └── ci.yml             # CI + npm publish on tag
├── eslint.config.mjs
├── tsconfig.json
├── package.json
├── .env.example
└── README.md
```

## License

MIT
