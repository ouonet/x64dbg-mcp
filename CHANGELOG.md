# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Bridge protocol compatibility**: when a change modifies the JSON contract between
> `src/bridge.ts` and `plugin/x64dbg_mcp_bridge.py`, the minor version must be bumped.
> Both sides must be updated together and released as a single version.

---

## [Unreleased]

## [1.3.0] - 2026-05-22

### Added

- **Live state polling in Python bridge** — background thread polls x64dbg state every 100 ms and
  pushes `stateChange` events to all connected clients. Covers state transitions driven by the
  x64dbg UI or external events between MCP commands (e.g. user clicks Run/Pause, process exits
  naturally).
- **`debug.getState` bridge method** — queried by the TS server immediately after the probe
  handshake succeeds (`"ready"` event) to synchronise initial session state.
- **Active health check for orphaned sessions** — detects sessions whose bridge connection was
  silently lost and terminates them with `terminationReason: "bridge_lost"`.
- **`"idle"` session state** — initial state when the bridge is connected but no debuggee has been
  loaded yet. Enables a clear `idle → loading → paused/running` lifecycle. After a debuggee exits
  the session returns to `"idle"` rather than being torn down.
- **`"ready"` event on `BridgeClient`** — emitted after the `protocol.probe` handshake succeeds;
  callers can now reliably schedule post-connect work without racing the probe.

### Fixed

- `MAX_SESSIONS` cap was not enforced in the tool layer for concurrent `load_executable` /
  `attach_to_process` calls — now checked atomically before port allocation.
- `load_executable` timeout path now includes richer diagnostics (`state`, `pauseReason`,
  `recentEvents`) when the 60 s safety timer fires.
- `bridges.terminate()` now passes `"bridge_lost"` as `terminationReason` when a bridge
  disconnects unexpectedly, rather than leaving it as `"unknown"`.

### Changed

- `SessionManager.createLoading()` renamed to `createIdle()`; initial session state is now
  `"idle"`. `applyStateChange({ state: "loading" })` is called just before `debug.load` /
  `debug.attach` fires, preserving the full `idle → loading → paused/running` sequence.
- `DEBUG_STATES` enum extended to 5 values: `"idle"`, `"loading"`, `"running"`, `"paused"`,
  `"terminated"`.
- All 38 MCP tool descriptions rewritten for AI agent clarity — each description now includes
  prerequisites (required session state), return value shape, `pauseReason` semantics, and
  recommended next-action guidance. Notably `load_executable` and `attach_to_process` now
  document the `system_breakpoint` intermediate pause and the normal load flow.
- Migrated all 38 tool registrations from the deprecated `server.tool()` overload to
  `server.registerTool()` (MCP SDK ≥ 1.x canonical API).

## [1.2.0] - 2026-05-18

### Breaking Changes

**7 tools removed** — use `execute_command` with x64dbg script syntax instead:
- `set_breakpoint` → `execute_command` with `bp <addr>` or `bphw <addr>`
- `remove_breakpoint` → `execute_command` with `bpd <addr>` / `bphwd <addr>`
- `list_breakpoints` → `execute_command` with `bplist`
- `run_to_address` → `execute_command` with `rtu <addr>`
- `set_register` → `execute_command` with `r <reg>=<value>`
- `switch_thread` → `execute_command` with `switchthread <tid>`
- `trace_execution` → `execute_command` with `tc <expr>` / `ticnd <expr>`

**Bridge protocol upgraded to v2** — old bridge plugins (protocol v1) are rejected with `E_PROTOCOL_VERSION`. Update the Python bridge files alongside this release.

**Execution tools return new envelope**: `continue_execution`, `step_into`, `step_over`, `step_out`, `pause_execution` now return `{ timedOut, state, pauseReason, terminationReason, lastEvent, recentEvents }` instead of the old `{ stopReason }` shape.

**`load_executable` / `attach_to_process`** now wait for the first meaningful pause event (entry breakpoint, system breakpoint, or crash) and return the same state snapshot envelope plus `recentEvents` containing the full load trail. A 60-second safety timeout returns `{ timedOut: true }` if no event is received.

**Session termination**: `terminate_session` and `detach_session` are idempotent. Terminated sessions remain accessible via read-only tools for a 30-second retention window (`E_SESSION_TERMINATED` is returned for write/execution tools).

### Added

- `wait_for_state(sessionId, { expect, timeoutMs?, pauseReasonFilter?, terminationReasonFilter? })` — wait for a session to reach a specific state; returns immediately if already matching; empty filter array `[]` matches nothing.
- `save_memory_dump(sessionId, address, size, outputPath)` — write a raw memory region to a file (max 256 MB).
- `create_minidump(sessionId, outputPath, dumpType?)` — create a Windows minidump (`normal` or `full`).
- Three-layer state model per session: `state` (loading/running/paused/terminated), `pauseReason` (`PauseReason` enum), `terminationReason` (`TerminationReason` enum).
- Per-session debug event ring buffer (50 entries, `recentEvents`).
- MCP notifications `x64dbg/debugEvent` and `x64dbg/stateChange` emitted on each bridge event.
- `E_SESSION_TERMINATED`, `E_PROTOCOL_VERSION`, `E_IO_FAILED`, `E_INVALID_ARGUMENT` error codes.
- New fixtures `test/fixtures/int3.c` and `test/fixtures/exception_bp.c`.
- `test/integration/state-observability.test.ts` covering D2/D3/D6/D8/D13/D15.

## [1.1.3] - 2026-05-09

### Added
- Multi-session support: a single MCP server instance can now spawn and manage multiple independent
  x64dbg processes simultaneously, each debugging a different target program.
  - `src/bridgeRegistry.ts` — new `BridgeRegistry` singleton keyed by `sessionId`; replaces the
    global `bridge` singleton. `bridgeFor(sessionId)` is the tool-layer accessor.
  - `src/launcher.ts` — `pickFreePort(min=30000, max=44999)` probes random ports below the Windows
    ephemeral range to avoid false-positive hits; `launchDebuggerOnPort(exe, port)` injects
    `BRIDGE_PORT` into the child's environment; `killDebuggerForSession`/`killAllDebuggers` for
    per-session and global teardown.
  - `src/session.ts` — `SessionManager.terminate(id)` is now `async` and cascades:
    `bridges.delete` → `killDebuggerForSession` → session entry removal.
  - `src/tools/debug.ts` — `load_executable` and `attach_to_process` rewritten with 6-step
    resource-ownership protocol and rollback on failure. All tools now call
    `bridgeFor(sessionId).call(...)` instead of the former global singleton.
  - `MAX_SESSIONS` env var (default `5`) enforced in `load_executable` and `attach_to_process`;
    exceeding the cap returns `E_SESSION_LIMIT` with the active session list.
  - `E_PORT_EXHAUSTED` error code added to `src/errors.ts`.
  - `bridgePort` field added to the `Session` type and exposed in `list_sessions`/`get_status`
    responses.
- Integration test suite `test/integration/multi-session.test.ts`: drives two concurrent
  x64dbg sessions (HTTP server + HTTP client Winsock PE fixtures) with `ws2_32.accept` and
  `ws2_32.connect` breakpoints; verifies port isolation, BP isolation, parallel dispatch,
  and clean per-session teardown.
- Test fixtures `test/fixtures/http_server.c` and `http_client.c`: minimal Winsock PE programs
  built with CMake + MSVC (`npm run build:fixtures`).
- `npm run test:integration` script to run the integration test.

### Changed
- `BridgeClient` is no longer a module-level singleton; it is constructed per-session via
  `new BridgeClient(host, port)`.
- Server startup no longer connects a global bridge; the MCP server starts in a zero-session
  state and connects only when `load_executable` or `attach_to_process` is called.
- Graceful shutdown iterates all active sessions and terminates them in parallel before killing
  any remaining x64dbg processes.
- Port allocation range moved from the Windows ephemeral pool (49152–65535) to 30000–44999 to
  prevent transient OS port reuse from causing false-positive `waitForBridge` probes.
- `load_executable` tool description updated to reflect multi-session support; removed stale
  "only one session at a time" wording.
- README updated: feature list, architecture diagram, config defaults, project structure, and
  testing commands now reflect multi-session architecture.

## [1.1.2] - 2026-05-08

### Changed
- Default HTTP port unified to `3602` across standalone and service modes (was `3000` for standalone).
  Updated `config.ts`, `cli.ts`, `.env.example`, and all documentation.

## [1.1.1] - 2026-05-08

### Added
- New `x64dbg-mcp service` subcommand tree to install/uninstall/start/stop/restart/status the MCP as a Windows service.
  - Service registers as `LocalSystem` and serves Streamable HTTP at `http://<host>:<port>/mcp` (default 127.0.0.1:3602).
  - Configuration is seeded into `%ProgramData%\x64dbg-mcp\.env`; the service reads it via `X64DBG_MCP_CONFIG`.
  - Optional `--elevate` flag spawns an elevated child via PowerShell `Start-Process -Verb RunAs` and streams its output back to the original terminal via a transcript file.
  - `status` includes a live MCP `initialize` health probe when the service is running.
- New manual smoke helper `scripts/manual/run_service_smoke.ps1` and npm script `test:service:smoke`.

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
