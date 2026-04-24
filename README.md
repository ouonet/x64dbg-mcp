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
- Bundled 32-bit Python embeddable for x32dbg plugin support

### Core Debugging (12 tools)
- `load_executable` — Load PE file, **auto-detect x86/x64, auto-launch debugger**, break on entry
- `continue_execution` / `step_into` / `step_over` / `step_out`
- `run_to_address` — Run until a specific address
- `set_breakpoint` — Software, hardware (execute/read/write/access), and memory BPs with conditions and log text
- `remove_breakpoint` / `list_breakpoints`
- `terminate_session` / `list_sessions`
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

**Total: 36 tools**

## Prerequisites

- **Node.js** ≥ 20
- **x64dbg** installed on Windows (or use the bundled copy under `x64dbg/`)
- **Python 3.10+** installed for x64dbg, or use the bundled 32-bit Python embeddable for x32dbg
- **CMake 3.15+** and a C compiler (MSVC / MinGW) to build the loader plugin

## Installation

```bash
# Clone and install
cd x64dbg-mcp
npm install
npm run build

# Build the loader plugin (64-bit)
cd plugin\loader
cmake -B build64 -A x64
cmake --build build64 --config Release
cd ..\..\n
# Copy plugin files into x64dbg
copy plugin\loader\build64\Release\x64dbg_mcp_loader.dp64  C:\x64dbg\plugins\
copy plugin\x64dbg_bridge_sdk.py  C:\x64dbg\plugins\
copy plugin\x64dbg_mcp_bridge.py  C:\x64dbg\plugins\
```

## Configuration

Copy `.env.example` to `.env` and adjust:

```env
X64DBG_PATH=C:\x64dbg
BRIDGE_HOST=127.0.0.1
BRIDGE_PORT=27042
LOG_LEVEL=info
MAX_SESSIONS=5
SESSION_TIMEOUT_MS=3600000
```

## Usage

### 1. Configure your AI host

> **Note:** You no longer need to manually start x64dbg. The MCP server auto-launches
> the correct debugger (x32dbg or x64dbg) when you call `load_executable`.
> The loader plugin automatically initialises Python 3, runs the bridge script,
> and starts a TCP listener on port 27042.

#### Windsurf / Cascade

Add to your MCP settings:

```json
{
  "mcpServers": {
    "x64dbg-mcp": {
      "command": "node",
      "args": ["C:\\path\\to\\x64dbg-mcp\\dist\\server.js"],
      "env": {
        "BRIDGE_PORT": "27042"
      }
    }
  }
}
```

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

### 2. Start debugging

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

## Testing

```bash
# Test with MCP Inspector
npm run inspector

# Development mode (no build step)
npm run dev
```

## Project Structure

```
x64dbg-mcp/
├── src/
│   ├── server.ts          # Entry point
│   ├── bridge.ts          # TCP client to x64dbg bridge
│   ├── launcher.ts        # Auto-detect PE arch & spawn debugger
│   ├── session.ts         # Session lifecycle management
│   ├── config.ts          # Configuration from env
│   ├── logger.ts          # Winston logger (stderr only)
│   ├── types.ts           # TypeScript type definitions
│   └── tools/
│       ├── index.ts       # Tool registration barrel
│       ├── debug.ts       # Core debugging tools
│       ├── memory.ts      # Memory & register tools
│       ├── analysis.ts    # Analysis tools
│       └── security.ts    # Security analysis tools
├── plugin/
│   ├── x64dbg_mcp_bridge.py   # TCP server + handler dispatch (Python 3)
│   ├── x64dbg_bridge_sdk.py   # ctypes bindings to x64bridge.dll
│   ├── loader/
│   │   ├── x64dbg_mcp_loader.c # C plugin that embeds Python 3
│   │   └── CMakeLists.txt      # Build system for the loader
│   └── README.md
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## License

MIT
