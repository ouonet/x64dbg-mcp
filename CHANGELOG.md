# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Bridge protocol compatibility**: when a change modifies the JSON contract between
> `src/bridge.ts` and `plugin/x64dbg_mcp_bridge.py`, the minor version must be bumped.
> Both sides must be updated together and released as a single version.

---

## [Unreleased]

### Changed
- `plugin/loader/prebuilt/` added to `.gitignore`; compiled `.dp32`/`.dp64` artifacts
  are no longer tracked in git and will be produced by CI as release artifacts.
- `package.json` `files` list is now explicit (individual scripts) instead of the
  entire `scripts/` directory; `ci.mjs` is excluded from the published package.
- `install-plugin` npm script now delegates to `scripts/install-plugin.mjs`; on
  non-Windows platforms the script exits cleanly with a notice instead of failing.
- README tool count corrected from 36 to 39; `get_status`, `close_debugger`, and
  `collect_bp_args` were missing from the Core Debugging section.
- `BRIDGE_AUTH_TOKEN` is now mandatory. The MCP server refuses to start if the token
  is not set; the Python bridge now rejects all connections when no token is configured
  (previously an empty token disabled auth entirely). `.env.example` updated accordingly.
- C loader plugin (`x64dbg_mcp_loader.c`) Strategy 4 now uses `LoadLibraryExA` with
  `LOAD_LIBRARY_SEARCH_DEFAULT_DIRS` instead of a bare `LoadLibraryA("python3.dll")`
  call, eliminating the current-directory DLL planting risk.
- `_read_ptr_at` in `x64dbg_mcp_bridge.py` now reads 8 bytes on 64-bit and 4 bytes on
  32-bit, fixing silent pointer truncation when running under x64dbg.
- `postinstall.mjs` now prints explicit `X64DBG_PATH` instructions when the x64dbg
  download fails, instead of a bare warning with no recovery guidance (#29).
- `src/errors.ts` introduces `ErrorCode` enum and `McpError` class for structured,
  typed error propagation across the MCP server (#26). `SessionManager` uses `McpError`
  for session-limit and not-found errors (#10).
- `logToolCall(method, sessionId, durationMs, error?)` helper added to `src/logger.ts`
  for consistent structured per-call observability (#25).
- `test:e2e` and `test:e2e:py` npm scripts expose `test_mcp_client.mjs` and
  `test_mcp_e2e.py` as runnable commands (require live bridge + compiled server) (#11).
- Unit test suite extended from 27 to 37 tests: mock TCP server protocol tests,
  `ErrorCode`/`McpError` invariants, and `logToolCall` smoke tests (#10).
- `MAX_SESSIONS` environment variable removed; the session limit is now hardcoded to 1
  and no longer configurable (the bridge supports exactly one active session) (#1).
- `SessionManager.peek(id)` added: read-only session lookup that does not update
  `lastActivity`, for use by status-only operations (#22).
- `BridgeRequest` now includes a `protocolVersion: "1"` field on every request to
  allow the bridge plugin to detect incompatible clients in future versions (#17).
- `BridgeClient.drain(timeoutMs?)` added: waits for all in-flight requests to settle
  before closing the socket during graceful shutdown (#3).
- Graceful shutdown in `server.ts` now calls `bridge.drain()` before `disconnect()`,
  preventing in-flight requests from being rejected on SIGINT/SIGTERM/pipe-close (#3).
- `wrapTool(method, fn)` higher-order function exported from `src/tools/index.ts`:
  wraps any tool handler with automatic error catch + `logToolCall` instrumentation (#16).
- `launchDebugger` and `launchAndConnect` no longer accept a `cmdLineArgs` parameter —
  command-line arguments are passed via `debug.load` after the bridge is ready (#5).
- `debug.load` (`breakOnEntry=false`) now issues a `pause` command after `erun`,
  waits for the debuggee to stop, gathers stable state (pid, entry, modules) and runs
  `autoAnalyze`, then resumes — eliminating the 500 ms sleep race condition (#4).
- `debug.collectBreakpointArgs` auto-selects the architecture-appropriate default
  expression: `"rcx"` for x64 (Windows fastcall first arg) and `"ptr_utf16@[esp+4]"`
  for x86 (stdcall/cdecl first arg); `_read_ptr_at` now uses debuggee ptr size instead
  of debugger process `sys.maxsize` (#6).
- `debug.listBreakpoints` and `analysis.getModules` are dispatched without
  `_dispatch_lock` (added to `_LOCKLESS_HANDLERS`) so status queries remain responsive
  during long-running operations (trace, continue) that hold the lock (#9).
- `_require_x64dbg` now uses `_x64dbg_probe_lock` with double-checked locking to
  protect concurrent re-probes of `INSIDE_X64DBG`; `contextlib` imported for
  `nullcontext` in lockless dispatch (#27).

---

## [1.0.0] - 2026-04-27

Initial public release.

### Added
- MCP server (`src/server.ts`) exposing 36 tools across 4 categories: debug, memory,
  analysis, security.
- TCP bridge client (`src/bridge.ts`) with UUID-based request tracking, exponential
  backoff reconnect, and optional `BRIDGE_AUTH_TOKEN` authentication.
- Session manager (`src/session.ts`) with idle-timeout GC.
- Auto-launcher (`src/launcher.ts`): detects PE architecture (x86/x64), locates and
  spawns the correct x32dbg/x64dbg executable, polls TCP port until bridge is ready.
- Python bridge plugin (`plugin/x64dbg_mcp_bridge.py`): TCP server running inside
  x64dbg, dispatches JSON-RPC style requests to x64dbg Bridge SDK.
- Bridge SDK wrapper (`plugin/x64dbg_bridge_sdk.py`): ctypes bindings for
  `x64bridge.dll`/`x32bridge.dll`, no dependency on `x64dbgpy`.
- C loader plugin (`plugin/loader/x64dbg_mcp_loader.c`): lightweight `.dp64`/`.dp32`
  that loads `python3.dll` and starts the Python bridge in a background thread.
- Post-install script: auto-detects x64dbg, downloads snapshot if missing, generates
  `.env`, deploys plugin files and auth token.
- `scripts/doctor.mjs`: pre-flight diagnostics covering Node.js version, Python
  version, x64dbg path, plugin files, auth token, and TCP bridge reachability.
- Pre-built loader binaries included in npm package via `prepack` validation.
