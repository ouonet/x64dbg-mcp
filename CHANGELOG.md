# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Bridge protocol compatibility**: when a change modifies the JSON contract between
> `src/bridge.ts` and `plugin/x64dbg_mcp_bridge.py`, the minor version must be bumped.
> Both sides must be updated together and released as a single version.

---

## [Unreleased]

## [1.1.0] - 2026-05-07

### Added
- Optional MCP Streamable HTTP transport alongside the existing STDIO entry path.
  - New HTTP server bootstrap in `src/httpServer.ts` with per-session MCP server instances.
  - New `src/mcpServer.ts` factory to share tool registration across STDIO and HTTP startup paths.
  - New transport-related config keys: `MCP_TRANSPORT`, `MCP_HTTP_HOST`, and `MCP_HTTP_PORT`.
- New HTTP transport regression coverage in `test/basic.test.ts` that initializes a real Streamable HTTP client and verifies tool discovery.
- New manual HTTP smoke helpers:
  - `scripts/manual/test_http_transport.mjs` for HTTP connect, `get_status`, tool listing, and optional `load_executable` / `attach_to_process` validation.
  - `scripts/manual/run_http_attach_process_name_smoke.ps1` for a one-command Windows `TARGET_PROCESS_NAME` attach smoke run.
- New npm scripts:
  - `test:http-smoke`
  - `test:http-smoke:attach:process-name`

### Changed
- HTTP startup now prefers CLI flags such as `--transport streamable-http --host localhost --port 3000`; the HTTP endpoint path is fixed at `/mcp` and the legacy standalone SSE transport is not exposed as a startup mode.
- `test:http-smoke` now rebuilds `dist/` before launching the manual HTTP smoke script so the validation path always uses the latest server entrypoint.
- README and `.env.example` now document the CLI-first HTTP startup flow, transport configuration, HTTP client connection, and the new smoke-test flows.

## [1.0.2] - 2026-05-06

### Added
- New `attach_to_process` MCP tool to attach to a running process by PID.
  - Auto-detects target architecture (x86/x64).
  - Auto-launches the appropriate debugger when needed.
  - Returns session metadata including PID, architecture, and entry point.
- New `detach_session` MCP tool to detach from the current debuggee without terminating the target process.
- New `pause_execution` MCP tool and matching `debug.pause` bridge handler for asynchronously breaking a running debuggee.
- New Python bridge handlers `debug.attach` and `debug.detach`.
- New reusable verifier layout under `test/e2e/`, including `_target.mjs` for explicit `TARGET_EXE`, `TARGET_PID`, and `TARGET_PROCESS_NAME` resolution.
- New offline regression coverage in `plugin/tests/test_bridge.py` for attach, detach, breakpoint selection, and stop-reason inference.

### Changed
- `launchDebuggerForAttach()` now starts a plain debugger instance and lets bridge-side `debug.attach` perform the single attach step.
- Reusable verification scripts were moved from the repository root into `test/e2e/`.
- Manual debugging helpers were moved into `scripts/manual/`.
- README, CI, and npm scripts now point to `test/e2e/test_mcp_client.mjs` and `plugin/tests/test_bridge.py`.
- Reusable verifiers are now machine-agnostic and require explicit target selection instead of baked-in local sample paths or process names.
- `debug.stepOut` now runs to the return site and steps past the `ret` instruction before reporting the caller location.
- Breakpoint helpers now select the correct x64dbg commands for memory breakpoints and breakpoint removal by type.

### Fixed
- `AttachDebugger` now receives the PID as an explicit hex expression, avoiding x64dbg's default hex parsing from attaching to the wrong process.
- Attach flows now handle stale or phantom debugger state more safely before reattaching.
- Detach flows now treat x64dbg's transient `$pid == 0` state as a successful detach.
- `continue_execution` now recognizes memory-breakpoint hits by comparing breakpoint snapshots before and after execution.
- CI `TypeScript (Node 20/22)` tests now await the dynamic import used by the `x64dbgPath resolves to existing directory` check, preventing late `unhandledRejection` cascades.
- CI tests that require bundled x64dbg binaries now skip cleanly when the binaries are unavailable on the runner.
- Python offline tests use ASCII-only console separators and keep only the relevant `findall` regression guard.

### Removed
- Removed the redundant root-level Python E2E helper `test_mcp_e2e.py`.
- Removed the duplicate npm script `test:e2e:py`.
- Removed the old root-level `test_mcp_client.mjs` helper in favor of `test/e2e/test_mcp_client.mjs`.
- Removed the old `plugin/test_bridge.py` path in favor of `plugin/tests/test_bridge.py`.

## [1.0.1] - 2026-04-29

### Fixed
- `handle_debug_load` no longer falsely returns an idempotent "already loaded" response
  with `pid=0` on a fresh debugger session. The previous-path comparison now uses
  `prev_loaded` captured before mutation, the idempotent branch additionally requires
  `live_pid > 0`, and `_loaded_exe_path` is only updated after `InitDebug` succeeds.
- `handle_debug_load` no longer raises `"x64dbg refused to stop the previous debug
  session"` when the debugger is in a phantom "half-debugging" state with no real
  pid; it now logs and proceeds with `InitDebug`. The hard error is reserved for the
  case of a genuine live session that ignores `StopDebug`.
- `debug.load` response `entryPoint` now falls back to the current instruction pointer
  (`cip`) when `_eval_expr("entry")` returns 0, which happens on some targets even
  when the debuggee is paused at OEP.
- `load_executable` MCP handler now trims surrounding whitespace and quote characters
  from `executablePath`, so paths pasted with leading spaces no longer hit
  `Target executable not found`.

### Added
- `selftest.ps1` end-to-end harness that injects `PYTHON_HOME_X86`/`PYTHON_HOME_X64`
  from `.env`, spawns a fresh `x32dbg.exe`, polls TCP `27042`, exercises `debug.load`
  twice (cold + idempotent), and verifies the resulting OS process is the expected
  target.

### Changed
- Disassembly in `plugin/x64dbg_bridge_sdk.py::DbgDisasmAt` now uses the `iced_x86`
  Python package as the primary backend, with x64dbg's native disasm as fallback.
  `postinstall.mjs` auto-installs `iced_x86` into `PYTHON_HOME_X64` / `PYTHON_HOME_X86`,
  and `doctor.mjs` reports a warn-level check when it is missing.
- `get_breakpoint_list` now queries x64dbg per-`BPXTYPE` and dedupes results;
  the `BPXTYPE` constants are corrected to bit flags (1, 2, 4, 8, 16) instead of
  0..4. Fixes empty `list_breakpoints` after a successful `set_breakpoint`.
- `debug.stepInto`, `debug.stepOver`, and `analysis.trace` now wait for the debuggee
  to actually pause after each step before returning, eliminating stale RIP /
  duplicated trace samples.
- `debug.runToAddress` now loops past unrelated pauses (e.g. TLS callback breakpoints)
  until the temporary target breakpoint is reached, the process exits, or a small
  pause cap is hit; the temp BP is always cleaned up.
- `analysis.listFunctions`, `analysis.analyzeFunction`, and `analysis.getXrefs`
  now fall back to a bridge-side linear disassembly walk from the module entrypoint
  (caching results per module) when x64dbg's analysis database is empty, and prefer
  same-module callers when `analxrefs` returns only cross-module noise.
- `analysis.getModules` switched to Windows Toolhelp32 (`Module32FirstW`/`NextW`)
  instead of `DbgGetModuleList` to avoid destabilizing the 32-bit bridge during
  early loader states.
- `THREADALLINFO` / `BPMAP` / `DBGFUNCTIONS_PARTIAL` ctypes structures realigned to
  match `bridgemain.h`; `get_thread_list` now returns `currentThreadId`.
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
- `test:e2e` and `test:e2e:py` npm scripts expose `test/e2e/test_mcp_client.mjs` and
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
- `killDebugger()` now respects a `KEEP_DEBUGGER=1` environment variable: when set,
  shutdown skips the kill so users can preserve an in-progress x64dbg analysis session
  across MCP host restarts (#3).
- `BridgeClient.disconnect()` is now `async` and returns a `Promise<void>` that
  resolves only after the underlying socket emits its `close` event (with a 500 ms
  safety timeout), ensuring the file descriptor is fully released before the process
  exits (#28).
- Graceful shutdown in `server.ts` now `await`s `bridge.disconnect()` so the socket
  truly closes before `killDebugger()` is called (#28).
- `BridgeClient` `MAX_BUFFER_BYTES` increased from 4 MB to 16 MB to accommodate large
  trace / memory-search responses without triggering buffer-overflow disconnects (#8).
- `detectPEArchitecture` now recognises ARM64 (`0xAA64`) and ARM Thumb-2 (`0x01C4`)
  machine types and throws a descriptive error explaining that x64dbg only supports
  x86/x64, replacing the generic "Unsupported PE machine type" message (#7).
- `src/types.ts` Bridge Protocol section documents the camelCase ↔ snake_case field
  naming convention and lists all current cross-boundary field mappings (#18).
- README Development section now includes an MCP Inspector note about proxy/offline
  setup requirements (#19).

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
