# x64dbg MCP Bridge Plugin (Python 3)

This plugin runs **inside x64dbg** using a lightweight C loader that embeds
Python 3.10+. It calls the x64dbg Bridge SDK directly via `ctypes` —
**no x64dbgpy dependency**. A TCP server exposes the debugger to the MCP
Node.js process.

## Architecture

```
x64dbg process
├── x64dbg_mcp_loader.dp64  (C plugin — embeds Python 3)
│   ├── x64dbg_bridge_sdk.py (ctypes bindings to x64bridge.dll)
│   └── x64dbg_mcp_bridge.py (TCP server + handler dispatch)
```

## Prerequisites

1. **x64dbg** (snapshot 2024+ recommended)
2. **Python 3.10+** installed on the system (python3.dll must be loadable)
3. **CMake 3.15+** and a C compiler (MSVC or MinGW) to build the loader

## Building the Loader Plugin

```powershell
cd plugin\loader

# 64-bit plugin
cmake -B build64 -A x64
cmake --build build64 --config Release
# Output: build64\Release\x64dbg_mcp_loader.dp64

# 32-bit plugin (optional)
cmake -B build32 -A Win32 -DBUILD_32BIT=ON
cmake --build build32 --config Release
# Output: build32\Release\x64dbg_mcp_loader.dp32
```

If you have the x64dbg Plugin SDK, pass `-DX64DBG_SDK_DIR=<path>` to link
against the official bridge import library. Without it, the loader uses
minimal inline SDK definitions and resolves symbols at runtime.

## Installation

1. Copy the built plugin (`x64dbg_mcp_loader.dp64` / `.dp32`) into
   `<x64dbg>/plugins/`.
2. Copy these Python files **into the same `plugins/` directory**:
   - `x64dbg_bridge_sdk.py`
   - `x64dbg_mcp_bridge.py`
3. Copy the generated `x64dbg_mcp_bridge.token` file into the same `plugins/` directory,
   or set `BRIDGE_AUTH_TOKEN` in the environment before starting x64dbg.
4. Start x64dbg. The loader initialises Python 3, launches the bridge
   script in a background thread, and the TCP server starts listening.

## Configuration

| Environment Variable | Default       | Description                    |
|---------------------|---------------|--------------------------------|
| `BRIDGE_HOST`       | `127.0.0.1`  | TCP bind address               |
| `BRIDGE_PORT`       | `27042`       | TCP port                       |
| `BRIDGE_AUTH_TOKEN` | *(auto)*      | Shared secret for localhost clients |
| `PYTHON_HOME`       | *(auto)*      | Override Python install path   |

## Testing Standalone

You can run the bridge outside x64dbg for protocol testing:

```bash
python x64dbg_mcp_bridge.py
```

All x64dbg API calls will fail with a "requires running x64dbg instance"
error, but you can verify the TCP server and JSON protocol work correctly.

## Why not x64dbgpy?

x64dbgpy embeds Python 2.7 / 3.4 and hasn't been updated for modern Python
releases. This loader plugin embeds **any** Python 3.10+ via the stable ABI
(`python3.dll`), giving you access to modern language features and the full
PyPI ecosystem.
