# MCP Shell Architecture & State Observability

**Date**: 2026-05-09
**Target version**: 1.2.0 (breaking change — no backward compatibility shims)
**Scope**: redesign the tool surface and add real-time state observability so AI agents never block, never need to guess program state, and use their own debugging knowledge instead of server-encoded recipes.

---

## Constitution

> **MCP server = x64dbg shell + state observer + lifecycle manager.**
> - Manages x64dbg / session / target lifecycles.
> - Lets the AI agent perceive everything a human sees in the x64dbg GUI.
> - Provides a command channel (`execute_command`).
> - Debugging knowledge belongs to the AI agent, NOT to the server.
> - Wrap a capability as a tool ONLY when it provides value beyond a raw command — structured I/O, multi-step orchestration, lifecycle, or bridge-side computation.

Every tool retention/removal decision below derives from this constitution.

---

## Decisions

### D1. Tool surface (42 → 38 tools)

remove (7): `set_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `run_to_address`, `set_register`, `switch_thread`, `trace_execution`
why:    pure 1:1 x64dbg command wrappers with no structured benefit, or composite functionality the AI agent can build from `execute_command` + state queries.

keep (high-frequency execution — 5):
        `continue_execution`, `step_into`, `step_over`, `step_out`, `pause_execution`
why:    these are commands too, but they are the highest-frequency operations in any debug session. Keeping them halves call count for the common BP-and-run workflow and lets us return structured stop state on completion.

keep (lifecycle — 7):
        `load_executable`, `attach_to_process`, `terminate_session`, `detach_session`,
        `close_debugger`, `list_sessions`, `get_status`

keep (shell — 1):
        `execute_command`

keep (structured I/O — command output is text-only — 12):
        `read_memory`, `write_memory`, `search_memory`, `get_memory_map`,
        `get_registers`, `get_call_stack`, `get_threads`,
        `disassemble`, `get_modules`, `get_imports`, `get_exports`, `get_pe_header`

keep (bridge-side composite analysis — no single command equivalent — 4):
        `analyze_function`, `get_cross_references`, `list_functions`, `find_strings`

keep (fixed pattern + many repeated commands — 6):
        `detect_packing`, `analyze_suspicious_apis`, `detect_anti_debug`,
        `check_section_anomalies`, `generate_security_report`, `collect_bp_args`

add (3): `wait_for_state`, `save_memory_dump`, `create_minidump`

final count: 5 + 7 + 1 + 12 + 4 + 6 + 3 = **38** tools (down from 42).

### D2. State model (per session) — three layers

The session state has three layers, each answering a distinct question:

| Layer | Question | When meaningful |
|-------|---------|------------------|
| `state` | what coarse phase is the session in? | always |
| `pauseReason` | **why** is execution halted? | only when `state === "paused"` |
| `terminationReason` | **why** did the session end? | only when `state === "terminated"` |

In addition, every observable callback produces a `DebugEvent` recorded in a per-session ring buffer (`recentEvents`). The latest event is exposed as `lastEvent`. Pause and termination reasons are derived from specific events; non-pausing events (e.g., a `dll_load` while `break.dll_load = 0`) update `lastEvent`/`recentEvents` without changing `state` or `pauseReason`.

contract (returned by `get_status` and embedded in every execution-tool response):
```
{
  sessionId: string
  state: "loading" | "running" | "paused" | "terminated"
  pauseReason: PauseReason | null         // see D3 — non-null iff state === "paused"
  terminationReason: TerminationReason | null  // see D3 — non-null iff state === "terminated"
  currentThreadId: number | null          // x64dbg's notion of active thread
  currentPc: string | null                // hex; null when not paused
  currentModule: string | null            // module name owning currentPc
  bridgeConnected: boolean
  updatedAt: number                       // epoch ms when state last changed
  lastEvent: DebugEvent | null            // most recent event of any kind (see D3)
  recentEvents: DebugEvent[]              // see D4 (ring buffer)
}
```

invariants:
- `state` is updated synchronously inside the bridge by x64dbg callbacks before any tool call sees the value. The MCP server is never the authoritative state holder; the bridge is.
- `pauseReason !== null` iff `state === "paused"`.
- `terminationReason !== null` iff `state === "terminated"`.
- Transition `paused → running`: `pauseReason` is cleared to `null`. (Look in `recentEvents` for history.)
- `lastEvent` and `recentEvents` are updated for **every** debug callback regardless of whether the callback caused a state change.

**State boundary semantics:**

| state | starts | ends |
|-------|--------|------|
| `loading` | `InitDebug` / `AttachDebugger` invoked | first `CB_SYSTEMBREAKPOINT` fires, or `CB_CREATEPROCESS` completes for attach, whichever marks the debug session as live |
| `running` | bridge passes control to debuggee (any `run`/`step`/`erun` issued AND target actually resumed) | any callback that pauses execution fires |
| `paused` | any pause-causing callback fires (see D3) | next `run`/`step` resumes the target |
| `terminated` | `CB_EXITPROCESS` fires, or `StopDebug` / `DetachDebugger` completes, or bridge socket dies | (terminal — session must be recreated to debug again) |

invariant: once a session has entered `paused`, it can never go back to `loading`. The autoAnalyze phase (when `autoAnalyze=true`) belongs to `loading` if it runs before the first SYSTEMBREAKPOINT, or runs synchronously while still `paused` if it runs after entry.

### D3. Reasons and events — three separate enums

#### `PauseReason` — why execution is currently halted (only set when `state === "paused"`)

```
PauseReason =
  | "breakpoint"           // + bpAddress, bpType, bpKind, bpName?, hitCount?
  | "step"                 // (after StepInto/Over/Out)
  | "exception"            // + exceptionCode (hex), exceptionName, firstChance: bool
  | "tls_callback"         // + moduleName
  | "system_breakpoint"    // initial system BP (after InitDebug or attach)
  | "manual_pause"         // F12 in GUI, script `pause`, plugin-issued pause
  | "trace_terminated"     // + traceReason: "condition_met" | "step_limit" | "stopped"
  | "dll_load_break"       // ONLY when break.dll_load = 1 and a CB_LOADDLL paused us
  | "dll_unload_break"     // ONLY when break.dll_unload = 1
  | "thread_create_break"  // ONLY when break.thread_start = 1
  | "thread_exit_break"    // ONLY when break.thread_end = 1
  | "output_debug_break"   // ONLY when break.dbgstring = 1
  | "unknown"              // fallback — caller should inspect recentEvents
```

#### `TerminationReason` — why the session ended (only set when `state === "terminated"`)

```
TerminationReason =
  | "process_exit"      // + exitCode — target died (natural exit, StopDebug, crash, external kill)
  | "detached"          // DetachDebugger completed; target keeps running independently
  | "bridge_lost"       // bridge socket disconnected before a clean termination event
  | "unknown"           // fallback
```

#### `DebugEvent` — every observable callback (regardless of pause)

```
DebugEvent = {
  kind: DebugEventKind
  timestamp: number              // epoch ms
  address: string | null         // hex; null for events without a meaningful address (e.g., thread_exit)
  threadId: number | null
  pausedExecution: boolean       // did this event cause the current pause?
  // kind-specific fields below — see enum mapping
}

DebugEventKind =
  | "breakpoint"           // + bpAddress, bpType, bpKind, bpName?, hitCount?
  | "step"
  | "exception"            // + exceptionCode, exceptionName, firstChance
  | "tls_callback"         // + moduleName
  | "dll_load"             // + moduleName, moduleBase   (pausedExecution: true iff break.dll_load=1)
  | "dll_unload"           // + moduleName                (pausedExecution: true iff break.dll_unload=1)
  | "thread_create"        // + newThreadId, startAddress (pausedExecution: true iff break.thread_start=1)
  | "thread_exit"          // + exitedThreadId, exitCode  (pausedExecution: true iff break.thread_end=1)
  | "process_create"       // + pid, entryPoint           (typically pausedExecution: false; succeeded by system_breakpoint)
  | "process_exit"         // + exitCode                  (terminal — drives terminationReason="process_exit")
  | "system_breakpoint"    // initial system BP           (pausedExecution: true)
  | "manual_pause"         // F12 / script `pause` / plugin pause (pausedExecution: true)
  | "output_debug_string"  // + message                   (pausedExecution: true iff break.dbgstring=1)
  | "trace_terminated"     // + traceReason               (pausedExecution: true)
  | "detached"             // DetachDebugger succeeded    (terminal — drives terminationReason="detached")
```

Note on timeouts: there is NO `timeout` value in either `PauseReason`, `TerminationReason`, or `DebugEventKind` — timeouts are not x64dbg-generated events. Sync-mode execution tools (D5) and lifecycle tools (D13) report timeout outcomes via the `timedOut: boolean` field on the response envelope. The session-state model in D2 stays clean: `pauseReason` and `terminationReason` reflect only real x64dbg-observed reasons.

#### Breakpoint sub-discriminators (used by `breakpoint` event and `pauseReason="breakpoint"`)

```
bpType =                   // category of breakpoint that fired
  | "sw"                   // software (INT 3 written by debugger)
  | "hw"                   // hardware (DR registers)
  | "mem"                  // memory (PAGE_GUARD)
  | "dll"                  // library load BP (LibrarianSetBreakpoint / bpdll)
  | "exception"            // exception BP (SetExceptionBPX) — fires on a specific exception code

bpKind =                   // origin of the breakpoint
  | "user"                 // explicitly set by the AI agent / human
  | "temporary"            // internal, set by x64dbg for run-to-address / rtu / etc.
  | "system"               // x64dbg-managed system BPs (rarely surfaced under "breakpoint")
```

source: x64dbg plugin callbacks (`CB_BREAKPOINT`, `CB_STEPPED`, `CB_EXCEPTION`, `CB_LOADDLL`, `CB_UNLOADDLL`, `CB_CREATETHREAD`, `CB_EXITTHREAD`, `CB_CREATEPROCESS`, `CB_EXITPROCESS`, `CB_SYSTEMBREAKPOINT`, `CB_OUTPUTDEBUGSTRING`, `CB_PAUSEDEBUG`).

#### Event → `pauseReason` mapping (bridge dispatch rule)

When a `DebugEvent` is emitted with `pausedExecution: true`, the bridge MUST set `pauseReason` according to this table:

| Event `kind` | Resulting `pauseReason` |
|--------------|--------------------------|
| `breakpoint` | `breakpoint` |
| `step` | `step` |
| `exception` | `exception` |
| `tls_callback` | `tls_callback` |
| `system_breakpoint` | `system_breakpoint` |
| `manual_pause` | `manual_pause` |
| `trace_terminated` | `trace_terminated` |
| `dll_load` (when `pausedExecution: true`) | `dll_load_break` |
| `dll_unload` (when `pausedExecution: true`) | `dll_unload_break` |
| `thread_create` (when `pausedExecution: true`) | `thread_create_break` |
| `thread_exit` (when `pausedExecution: true`) | `thread_exit_break` |
| `output_debug_string` (when `pausedExecution: true`) | `output_debug_break` |

Other events update `lastEvent`/`recentEvents` but do NOT change `state` or `pauseReason`.

invariant: the `_break` suffix on `dll_load_break` etc. is deliberate. `DebugEventKind` has `dll_load` (always emitted on CB_LOADDLL); `PauseReason` has `dll_load_break` (only set when the load also paused execution). The distinct names make the dispatch rule unambiguous at the type level: AI agents reading `pauseReason === "dll_load_break"` know definitively the program is paused because of a DLL load, whereas a bare `dll_load` would be ambiguous between "paused on it" and "just observed it".

#### Event → `terminationReason` mapping

| Event `kind` | Resulting `terminationReason` |
|--------------|--------------------------------|
| `process_exit` | `process_exit` |
| `detached` | `detached` |
| (bridge socket dies without a terminal event) | `bridge_lost` |

#### Classification rules (must be enforced by the bridge dispatcher — these are easy to get wrong)

1. **Hardcoded `int 3` / `__debugbreak()` in the target binary** → `DebugEvent { kind: "exception", exceptionName: "EXCEPTION_BREAKPOINT" }` (code `0x80000003`). NOT `kind: "breakpoint"`. The bridge distinguishes by checking whether the trapping address has a registered user / temporary BP; if not, it's a hardcoded debug break.

2. **Hardware breakpoint hit** is delivered by the OS as `STATUS_SINGLE_STEP` (`0x80000004`). The bridge MUST route it through `CB_BREAKPOINT` with `bpType: "hw"`, NOT as an exception. x64dbg handles this internally; the bridge must inspect which callback fired, not the raw exception code.

3. **Memory breakpoint hit** is delivered by the OS as `STATUS_GUARD_PAGE_VIOLATION`. Same rule: route via `CB_BREAKPOINT` with `bpType: "mem"`.

4. **Temporary breakpoints** (`run_to_address`, `RunToUserCode`, `RunToParty`) are written by x64dbg with a `$temp_*` name. The bridge MUST emit `bpKind: "temporary"`.

5. **Script `pause` / plugin-injected pause** → `kind: "manual_pause"`. We do not try to distinguish source.

6. **Concurrent events**: each callback produces its own `DebugEvent` in `recentEvents`, ordered by `timestamp`. `lastEvent` is the most recent one. The bridge never coalesces events. When several events fire in succession during the same "pause window" (e.g., several DLL loads then a BP), each updates `lastEvent`; `pauseReason` is set by the last pause-causing event in the sequence.

7. **Exception breakpoint (`SetExceptionBPX` / `bpType: "exception"`)**: when the target raises an exception that matches a user-set exception BP, x64dbg fires CB_EXCEPTION followed (logically) by the BP intercept. The bridge MUST coalesce these into a single `DebugEvent { kind: "breakpoint", bpType: "exception", bpKind: "user" }` so the AI agent doesn't see the same cause twice. The original exception code/name is carried as additional fields (`exceptionCode`, `exceptionName`) on the breakpoint event for context.

8. **DLL-load breakpoint (`bpdll` / `bpType: "dll"`)**: when a DLL loads and a user-set bpdll matches, x64dbg fires CB_LOADDLL and the BP intercept. Same coalescing rule: emit ONE `DebugEvent { kind: "breakpoint", bpType: "dll", bpKind: "user", moduleName }`. The standalone `dll_load` event is suppressed for the matched module to avoid duplication. (Other unmatched DLL loads in the same window are emitted normally.)

### D4. Event buffer (per session)

invariant: each session maintains an in-memory ring buffer of the last 50 `DebugEvent`s, in chronological order. Buffer is appended to on every callback (pause-causing or not). Buffer is preserved through the terminated-retention window (D15) and dropped only when the session is reaped.

contract: `get_status(sessionId)` includes `recentEvents`. Clients that never consume MCP notifications can replay history.

deferred: pagination / `since` cursor for large windows — 50 is enough for typical AI agent flows. Revisit if it bites.

### D5. Execution mode (sync vs async)

contract:
```
continue_execution(sessionId, { async?: boolean = false, timeoutMs?: number = 30000 })
step_into / step_over / step_out(sessionId, { async?: boolean = false, timeoutMs?: number = 30000 })
pause_execution(sessionId,   { async?: boolean = false, timeoutMs?: number = 30000 })
→ { timedOut: boolean, ...stateSnapshot }    // see D2 for snapshot fields
```

All five tools share the same envelope and sync/async semantics.

sync (`async: false`, default):
- For `continue_execution` / `step_*`: bridge blocks until any pause-causing event OR `timeoutMs` elapses.
- For `pause_execution`: bridge issues the `pause` command, then blocks until `CB_PAUSEDEBUG` confirms the pause OR `timeoutMs` elapses. (If the session is already `paused`, returns immediately with `timedOut: false`.)
- returns the full state snapshot (D2) PLUS `timedOut: boolean`.
  - If a pause occurred / was confirmed: `timedOut: false`, `state: "paused"`, `pauseReason` set per D3.
  - If timeout fired: `timedOut: true`, snapshot reflects the **real** session state (typically `state: "running"`, `pauseReason: null` — D2 invariants are preserved).
- AI agent gets one tool call → one definitive answer.

async (`async: true`):
- For `continue_execution` / `step_*`: issues the run/step command and returns immediately.
- For `pause_execution`: issues the pause command and returns immediately (state may not yet be `paused`).
- returns `timedOut: false` and the current snapshot (typically `state: "running"`).
- AI agent uses `wait_for_state` or polls `get_status` to confirm transition.
- never blocks the MCP transport.

invariant: regardless of mode, every call returns within `timeoutMs` (or instantly for async). AI agent is never "stuck waiting".

invariant: the D2 state model is never violated by the `timedOut` flag. The flag is a property of the **tool call's outcome**, not of the session state. `pauseReason` and `state` remain in lock-step per D2.

invariant: this is a breaking change to the v1.1.x execution-tool signatures. Pre-v1.2.0 callers of `continue_execution`, `step_into`, `step_over`, `step_out`, `pause_execution` passed only `sessionId`; the tools returned different shapes per implementation. In v1.2.0, all five accept an optional second arg `{ async?, timeoutMs? }` (both defaulted, so positional-only calls still work) and ALL return the new `{ timedOut, ...stateSnapshot }` envelope. AI agents using the v1.1 response shape will see runtime errors when they parse the response.

### D6. `wait_for_state` tool

contract:
```
wait_for_state(sessionId, {
  expect: "paused" | "terminated" | "running",
  timeoutMs?: number = 30000,
  pauseReasonFilter?: PauseReason[],            // optional: only wake on these pause reasons
  terminationReasonFilter?: TerminationReason[], // optional: only wake on these termination reasons
})
→ { matched: boolean, ...stateSnapshot }   // full state snapshot (D2)
```

semantics: server-side block on a per-session `Condition`. Wakes when:
- `state` matches `expect`, AND
- if `expect === "paused"` and `pauseReasonFilter` provided: current `pauseReason ∈ pauseReasonFilter`, AND
- if `expect === "terminated"` and `terminationReasonFilter` provided: current `terminationReason ∈ terminationReasonFilter`.

On timeout, returns `{matched: false}` with current state. The two filters are independent — agents typically use only one at a time.

invariant: if the session already satisfies the wait condition at the time of the call, `wait_for_state` returns **immediately** with `matched: true` (no extra block). This makes the tool safely idempotent in race-condition retries.

invariant: empty filter array (`pauseReasonFilter: []`) means "match nothing" (filter is active but matches no reason); `undefined` (filter absent) means "no filter, match any reason". Same for `terminationReasonFilter`.

invariant: `wait_for_state` uses a per-session **state-change condition variable**, NOT the bridge dispatch lock. This means:
- Multiple `wait_for_state` calls on the same session can be in flight simultaneously; all wake when a state change matches their respective conditions.
- `wait_for_state` can run concurrently with an in-flight sync-mode `continue_execution` / `step_*` / `pause_execution` on the same session. The execution tool returns when its sync wait is satisfied; the wait_for_state call returns when its condition is satisfied. They do NOT serialize each other and they do NOT deadlock.
- The implementation must keep the state-change CV separate from the bridge's per-session dispatch lock.

### D7. MCP notifications (push channel)

invariant: the MCP server emits two kinds of notifications.

1. **`x64dbg/debugEvent`** — fires for every `DebugEvent`, regardless of whether it caused a state change. Params: `{sessionId, event: DebugEvent}`.
2. **`x64dbg/stateChange`** — fires when `state` transitions (loading→paused, paused→running, paused→terminated, etc.). Params: full state snapshot from D2.

invariant: clients that don't consume notifications are still fully functional — `get_status` and the event buffer (D4) cover the same information. Notifications are an **optional** performance / latency optimization for clients that choose to consume them; consuming side is never required for correctness.

### D8. New wrapper tools (`save_memory_dump`, `create_minidump`)

contract:
```
save_memory_dump(sessionId, { address: string, size: number, outputPath: string })
→ { savedTo: string, bytesWritten: number }

create_minidump(sessionId, { outputPath: string, dumpType?: "normal" | "full" = "normal" })
→ { savedTo: string, fileSize: number }
```

why: the underlying `savedata` and `minidump` commands accept paths but return only text. The tool wrapper validates the output path, calls the command, and returns a structured success/error with the absolute path. Justifies its own existence per the constitution (structured I/O).

invariants for `outputPath` (both tools):
- MUST be an absolute path. Relative paths are rejected with `E_INVALID_ARGUMENT`.
- MUST refer to a file (not an existing directory). If `outputPath` resolves to an existing directory or has a trailing path separator → `E_INVALID_ARGUMENT`.
- Parent directory MUST exist. The tool does NOT create directories. If missing → `E_INVALID_ARGUMENT`.
- If file already exists, it is **overwritten** silently. No "no-clobber" mode in v1.2.0.
- If write fails (permissions, disk full, etc.), tool returns `E_IO_FAILED` with the underlying error message.
- `savedTo` in the response is the **resolved absolute path** (after canonicalization).

invariants for `save_memory_dump`:
- `address` MUST be a hex string parseable by x64dbg's expression evaluator (e.g., `"0x401000"`, `"kernel32.LoadLibraryA"`, `"rip"`).
- `size > 0` and `size ≤ 256 MB`. Larger sizes rejected with `E_INVALID_ARGUMENT` to prevent OOM.
- If the address is unreadable (unmapped page, guard page), tool returns `E_BRIDGE` with x64dbg's error.

invariants for `create_minidump`:
- `dumpType: "normal"` produces a small minidump (threads, modules, stack only).
- `dumpType: "full"` produces a full memory dump (entire process memory; can be large).
- File size is reported in `fileSize` (bytes).

### D9. Removed tool migration

invariant: removed tools (`set_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `run_to_address`, `set_register`, `switch_thread`, `trace_execution`) are deleted outright. No deprecation shims. README, CHANGELOG, and `execute_command`'s tool description must list equivalent x64dbg commands so AI agents can transition.

mapping for `execute_command` description:
```
Breakpoints
- bp <addr>      / bph <addr> / bpm <addr>      → set software/hw/memory breakpoint
- bpdll <module>                                → set library-load breakpoint
- bc <addr>      / bphc <addr> / bpmc <addr>    → remove breakpoint
- bplist                                        → list breakpoints

Conditional / logging breakpoints
- bpcond <addr>, "<expr>"                       → set condition on existing BP
- bplog  <addr>, "<format>"                     → set log line on hit (instead of pause)
- SetBreakpointCommand <addr>, "<cmd>"          → run a command on hit
- GetBreakpointHitCount <addr>                  → query hit count
- ResetBreakpointHitCount <addr>                → reset hit count

Run-to / execution
- bp <addr>; run                                → run to address (one-shot)
- tc <expr>                                     → run until condition matches (temp BP)
- rtu                                           → run to user code

State manipulation
- r <reg>=<value>                               → set register
- switchthread <tid>                            → switch active thread

Tracing
- ticnd <cond> / tocnd <cond>                   → trace into / over with condition
- TraceSetLog <format>                          → set log format for trace
- StopTraceRecording                            → stop trace

For the full command reference see https://help.x64dbg.com/en/latest/commands/
```

### D10. Bridge protocol version bump

invariant: state-tracking changes the bridge JSON contract (new fields, new event push messages). Per `CLAUDE.md` rule, this is a minor bump on BOTH sides. New protocol version: `"2"` (from `"1"`).

invariant: `BridgeRequest.protocolVersion = "2"` going forward. Per D9 (no backward compat), the bridge plugin rejects any request with `protocolVersion != "2"` by responding with error code `E_PROTOCOL_VERSION` and a message instructing the operator to upgrade x64dbg-mcp + plugin together.

invariant (reverse direction — new MCP server connecting to old bridge): the MCP server issues a `protocol.probe` request immediately after `BridgeClient.connect()` succeeds, before any tool call routes to that bridge. The probe carries `protocolVersion: "2"`. Expected outcomes:
- New bridge replies with `{ protocolVersion: "2", capabilities: [...] }` → handshake OK.
- Old bridge replies with an unknown-method error (it doesn't know `protocol.probe`) → MCP server treats this as version mismatch and disconnects with `E_PROTOCOL_VERSION` surfaced to the failing tool call (typically `load_executable` / `attach_to_process`).
- Old bridge ignores `protocolVersion` field and responds normally → still a mismatch; the probe response shape is the discriminator. If the response lacks `protocolVersion: "2"`, treat as old.

This prevents silent degradation where a v1.2.0 MCP server runs against a v1.1 bridge that ignores event channels and state events.

error code inventory (must be reconciled with `src/errors.ts` at implementation time):

new codes (added in v1.2.0):
- `E_PROTOCOL_VERSION` — bridge received a request with mismatched `protocolVersion`.
- `E_SESSION_TERMINATED` — operation attempted on a session in `terminated` state (see D15).
- `E_IO_FAILED` — file write failed in `save_memory_dump` / `create_minidump` (D8).

existing codes (reused — verify presence in `src/errors.ts`):
- `E_INVALID_ARGUMENT` — schema validation, path validation, size limits (D8).
- `E_BRIDGE` — generic bridge-side error pass-through.
- `E_SESSION_NOT_FOUND` — sessionId doesn't exist or already reaped.
- `E_PORT_EXHAUSTED` — pickFreePort retries exhausted (existing from v1.1).

### D11. Bridge → MCP server event channel

decision: piggyback on the existing TCP socket. Bridge can send unsolicited frames in two shapes:
- `{type: "debugEvent", event: DebugEvent}`
- `{type: "stateChange", state: <state snapshot>}`

MCP server's `BridgeClient` already reads newline-delimited JSON; we add a dispatcher that routes by `type` to dedicated emitters (`BridgeClient.on("debugEvent")`, `BridgeClient.on("stateChange")`), separate from request/response correlation.

invariant: response frames keep their `id` field (request/response correlation unchanged). Event/state frames have no `id` — distinguishable by `type` field.

### D12. Tool description compaction

invariant: each retained tool's description must fit in roughly one paragraph (≤ 300 tokens). The constitution's "wrap only when justified" principle keeps the total description budget under control. `execute_command`'s description gets the longest entry (it's the escape hatch — includes the migration mapping from D9).

### D13. Lifecycle tool return semantics

Lifecycle tools (`load_executable`, `attach_to_process`) do NOT honor the sync / async / `timeoutMs` parameters from D5. Their return contract is fixed and tied to the lifecycle event they exist to drive:

| Tool / args | Returns when | Final state | Typical `pauseReason` / `terminationReason` |
|-------------|-------------|------------|----------------------------------------------|
| `load_executable(breakOnEntry=true)` | first pause after `InitDebug` (entry BP, or earlier TLS / exception intercept) | `paused` | `breakpoint` (bpKind=`temporary` for entry) or `tls_callback` or `exception` |
| `load_executable(breakOnEntry=false)` | bridge has issued `erun` and debuggee is actually running | `running` | n/a (lastEvent will reflect last loading-phase event, e.g., `dll_load`) |
| `attach_to_process(pid)` | DebugActiveProcess completes and the post-attach system BP fires | `paused` | `system_breakpoint` |
| `attach_to_process` where process exits during attach | `CB_EXITPROCESS` arrives during the attach window | `terminated` | `terminationReason: "process_exit"` |
| `load_executable` where target crashes before any pause | exception event fires before entry | `paused` | `exception` |
| `load_executable` where target exits before entry | `CB_EXITPROCESS` arrives | `terminated` | `terminationReason: "process_exit"` |

invariant: lifecycle tools have an implicit safety timeout of 60 seconds (covers autoAnalyze on large binaries + attach handshake). On timeout, the tool returns `timedOut: true` + the real snapshot (typically `state: "loading", pauseReason: null` per D2). The AI agent can either retry, terminate the session, or call `wait_for_state` to keep waiting.

invariant: by the time a lifecycle tool returns successfully, `recentEvents` contains the full trail from `InitDebug` / `AttachDebugger` to the returning state. AI agents that want to know what happened during load (e.g., which DLLs loaded, whether TLS fired) read `recentEvents` from the return value — no separate query needed.

contract: lifecycle tool return shape:
```
{ timedOut: boolean, ...stateSnapshot }
```
Same envelope as D5 execution tools. `timedOut: true` means the 60s safety timeout fired; `timedOut: false` means the load/attach reached its terminal state (`paused`, `running`, or `terminated`) within the window.

### D14. Termination / detach semantics

| Tool | Bridge call | Final state | `terminationReason` | Target process fate |
|------|-------------|-------------|----------------------|---------------------|
| `terminate_session(id)` | `StopDebug` (kills target) | `terminated` | `process_exit` (exitCode typically -1 or 0) | killed by debugger |
| `detach_session(id)` | `DetachDebugger` | `terminated` | `detached` | continues running independently |
| `close_debugger()` | `StopDebug` on every session | all `terminated` | `process_exit` per session | all killed |
| target naturally exits | `CB_EXITPROCESS` arrives | `terminated` | `process_exit` + real `exitCode` | already exited |
| target killed externally | `CB_EXITPROCESS` arrives | `terminated` | `process_exit` + real `exitCode` | already exited |
| x64dbg crashes / bridge socket dies | bridge `disconnected` event → cascade terminate | `terminated` | `bridge_lost` | indeterminate |

invariant: `terminate_session` and `detach_session` are **idempotent**. If the session is already `terminated` (e.g., target exited naturally before the AI agent reacted), both tools succeed without re-invoking the bridge and without raising errors. The existing `terminationReason` is preserved (NOT overwritten by the idempotent call).

invariant: after `detach_session`, the same PID **can** be re-attached via `attach_to_process(pid)`. This always creates a brand-new session with a fresh port, BridgeClient, and x64dbg instance; the old (terminated) session is not reused.

invariant: `terminate_session` and `detach_session` clean up resources in the same order as session GC (D15): bridge disconnect → kill owning x64dbg process → remove session entry. Partial failures during cleanup downgrade `terminationReason` to `unknown` but never block return.

### D15. Terminated session retention

invariant: once a session enters `terminated`, it is NOT immediately deleted from `SessionManager` / `BridgeRegistry`. It is retained for a **30-second grace window** to let the AI agent observe the final state via `get_status`, `list_sessions`, or any other read tool.

contract:
- During the 30s window:
  - Reads (`get_status`, `list_sessions`) succeed and reflect `terminated` state and `lastEvent`.
  - Writes / execution tools (`continue_execution`, `execute_command`, etc.) fail with `E_SESSION_TERMINATED` (new error code).
  - Calling `terminate_session` or `detach_session` on an already-terminated session is a no-op success (per D14 idempotency).
- A read or write call during the window refreshes `lastActivity`, **but does NOT extend** the 30s retention — the clock starts at termination, not at last access. This prevents accidental indefinite retention.
- After 30s, the GC reaper deletes the session entry, bridge entry (already disconnected), and x64dbg process tracking entry (already exited).

invariant: the global `SESSION_TIMEOUT_MS` (default 1 hour) continues to apply to non-terminated states (`loading`, `running`, `paused`). It does NOT override the shorter 30s retention for `terminated`.

deferred: configurable retention window (`TERMINATED_RETENTION_MS`). Hardcode 30s in v1.2.0; revisit if it bites.

---

## Tests

| What | How |
|------|-----|
| Tool count = 38 | unit: enumerate registered tools after `createMcpServer()` |
| Removed tools throw on call | unit: assert tools below D1.remove are absent |
| `get_modules` is registered and returns structured module list | unit: assert tool exists; integration: assert response shape |
| `pauseReason` is null in `running` / `loading` / `terminated` states | unit: drive state transitions, assert invariant |
| `terminationReason` is null in `running` / `loading` / `paused` states | unit: same |
| `continue_execution` sync returns within timeoutMs | unit (mock bridge): run with stale debuggee, assert ≤ timeoutMs + grace |
| `continue_execution` returns `timedOut: true` when program never pauses | integration with HTTP server fixture (busy-loop branch); also assert `state: "running"` and `pauseReason: null` (D2 invariant) |
| TLS callback pause returns `pauseReason: "tls_callback"` | integration: load any DLL-heavy target, assert pauseReason in response |
| BP hit returns `pauseReason: "breakpoint"` with bpAddress/bpType | integration: existing `multi-session.test.ts` flow |
| `dll_load` event with `pausedExecution: false` keeps pauseReason unchanged | integration: ensure break.dll_load=0, observe load, assert pauseReason stays as before |
| `dll_load` event with `break.dll_load=1` sets `pauseReason: "dll_load_break"` | integration: enable break.dll_load, observe load, assert pauseReason |
| `get_status.recentEvents` contains last 50 events, ring-buffered | unit: simulate 60 events, assert size == 50, oldest dropped |
| `wait_for_state(expect="paused")` blocks until match | integration: spawn pause-after-100ms target, call wait_for_state(timeoutMs=5000) |
| `wait_for_state` with pauseReasonFilter wakes only on matching reasons | integration: filter to ["breakpoint"], trigger tls_callback first, assert no wake |
| `wait_for_state` timeout returns `matched: false` with current state | integration: long-running target |
| Bridge rejects protocolVersion "1" | unit (mock bridge): send v1 request, assert E_PROTOCOL_VERSION error |
| `x64dbg/debugEvent` notification fires for every callback | unit: mock bridge sends 5 events, assert 5 notifications |
| `x64dbg/stateChange` notification fires only on state transitions | unit: emit non-pausing events, assert no state-change notifications |
| Hardware BP fires as `breakpoint` (not `exception`) | integration: set HW BP via `bph`, hit it, assert `pauseReason: "breakpoint"`, `bpType: "hw"` |
| Memory BP fires as `breakpoint` (bpType: "mem") | integration: set memory BP via `bpm`, trigger access, assert classification |
| DLL load BP fires as `breakpoint` (bpType: "dll") | integration: set `bpdll <name>`, load module, assert classification |
| Hardcoded `int 3` in target → `pauseReason: "exception"` + `EXCEPTION_BREAKPOINT` | integration: build fixture with `__debugbreak()`, load it, assert pauseReason=exception not breakpoint |
| Temporary BP from `run_to_address` reports `bpKind: "temporary"` | integration: invoke run-to via execute_command, hit it, assert bpKind |
| User-set BP reports `bpKind: "user"` | integration: existing `multi-session.test.ts` flow updated to assert this field |
| Trace stop reports `pauseReason: "trace_terminated"` + `traceReason` | integration: run `ticnd` with condition that matches after N steps, assert event shape |
| Concurrent events appear in `recentEvents` in timestamp order | unit (mock bridge): emit DLL_LOAD + BREAKPOINT in same tick, assert order preserved |
| `load_executable(breakOnEntry=false)` returns `state: "running", pauseReason: null` | integration: load HTTP server fixture with `breakOnEntry=false`, assert state field |
| `load_executable` returns `recentEvents` with `dll_load` trail | integration: assert response.recentEvents has dll_load entries for kernel32, ntdll, etc. |
| `attach_to_process` returns `state: "paused", pauseReason: "system_breakpoint"` | integration with a long-running fixture |
| `load_executable` returns `state: "terminated", terminationReason: "process_exit"` when target exits early | integration: fixture that ExitProcess at TLS, assert state |
| Lifecycle tools time out at 60s with `timedOut: true`, `state: "loading"`, `pauseReason: null` | unit (mock bridge): never fire system BP, assert tool returns after ~60s with envelope shape |
| `wait_for_state(expect="running")` wakes when state transitions to running | integration: load with breakOnEntry=true, call wait_for_state(expect="running"), continue, assert wake |
| `DebugEvent.pausedExecution` is true on pause-causing events | integration: trigger BP hit, find event in recentEvents, assert `pausedExecution: true` |
| `DebugEvent.pausedExecution` is false on notification-only events | integration: with break.dll_load=0, observe dll_load event in recentEvents, assert `pausedExecution: false` |
| Exception BP coalesces exception+BP into one event | integration: set `SetExceptionBPX`, trigger matching exception, assert `recentEvents` has exactly one `breakpoint` event (bpType="exception"), no separate `exception` event |
| DLL-load BP coalesces dll_load+BP for matched module | integration: set `bpdll user32.dll`, load user32, assert one `breakpoint` event (bpType="dll"), no separate `dll_load` for user32 |
| Bridge returns E_PROTOCOL_VERSION on mismatched version | unit (mock bridge): MCP server sends protocolVersion="3", assert E_PROTOCOL_VERSION error returned |
| `state` stays `loading` until first SYSTEMBREAKPOINT/CREATEPROCESS | unit: assert state transitions are loading → paused (never running until run is issued) |
| `detach_session` returns `state: "terminated", terminationReason: "detached"` | integration: load fixture, detach, assert response |
| Detached PID can be re-attached | integration: detach, then `attach_to_process(samePid)` succeeds with new session |
| `terminate_session` is idempotent after target exits naturally | integration: load fixture that ExitProcess quickly, wait, then call terminate_session → success no-op preserving terminationReason |
| `detach_session` is idempotent | integration: call detach twice, second call succeeds |
| Terminated session readable for 30s | unit: simulate terminated state, assert `get_status` succeeds for 30s |
| Execution tools fail with `E_SESSION_TERMINATED` after termination | unit: simulate terminated, call `continue_execution`, assert error code |
| Terminated session is reaped after 30s | unit (fast clock): simulate terminated, advance clock 31s, assert session entry gone |
| Read during retention window does NOT extend retention | unit: simulate terminated, call get_status repeatedly, advance clock 31s, assert reaped |
| Bridge crash mid-session results in `state: "terminated", terminationReason: "bridge_lost"` | unit (mock bridge): simulate socket close, assert state and reason |
| `pauseReason` clears on transition paused→running | unit: paused with pauseReason=breakpoint, issue run, observe pauseReason becomes null |
| `save_memory_dump` writes structured response with absolute path | integration: paused at a known address, save 64 bytes, assert file exists and bytesWritten === 64 |
| `save_memory_dump` rejects relative path with E_INVALID_ARGUMENT | unit: pass `outputPath: "dump.bin"`, assert error code |
| `save_memory_dump` rejects size > 256 MB | unit: pass `size: 300_000_000`, assert E_INVALID_ARGUMENT |
| `save_memory_dump` overwrites existing file silently | integration: write twice to same path, second write succeeds |
| `save_memory_dump` returns E_BRIDGE on unmapped address | integration: pass a known-unmapped address, assert error |
| `create_minidump("normal")` produces a small dump file | integration: paused state, dumpType=normal, assert fileSize < 10 MB for a small target |
| `create_minidump("full")` produces a larger dump file | integration: same fixture, dumpType=full, assert fileSize > "normal" fileSize |
| `wait_for_state` returns immediately when condition already met | unit: session is paused, call wait_for_state(expect="paused"), assert returned within 10ms with matched=true |
| `wait_for_state` with empty filter array matches nothing | unit: paused with pauseReason=breakpoint, call wait_for_state(expect="paused", pauseReasonFilter=[]), assert timeout (matched: false) |
| Partial cleanup failure during terminate_session sets terminationReason="unknown" | unit (mock bridge): make StopDebug succeed but x64dbg kill fail, assert terminationReason="unknown" but tool still returns success |
| `pause_execution` sync waits for CB_PAUSEDEBUG confirmation | integration: load with breakOnEntry=false (running), call pause_execution(async=false), assert state="paused" + pauseReason="manual_pause" on return |
| `pause_execution` async returns immediately without waiting for pause | integration: same setup, call pause_execution(async=true), assert returns within 100ms with state="running" |
| `pause_execution` on already-paused session returns immediately, timedOut=false | unit: paused state, call pause_execution, assert immediate return |
| `list_sessions` includes terminated session during 30s retention window | unit: simulate terminated state, call list_sessions, assert terminated session present with state="terminated" |
| `save_memory_dump` rejects outputPath that is an existing directory | unit: pass `outputPath` pointing to an existing dir, assert E_INVALID_ARGUMENT |
| `save_memory_dump` rejects outputPath with trailing separator | unit: pass `outputPath: "C:\\Users\\foo\\"`, assert E_INVALID_ARGUMENT |
| `save_memory_dump` rejects when parent directory does not exist | unit: pass `outputPath: "C:\\nonexistent\\dir\\file.bin"`, assert E_INVALID_ARGUMENT |
| `wait_for_state` can run concurrently with sync `continue_execution` | integration: spawn 2 parallel calls on same session (continue + wait_for_state), assert both return on same pause event without deadlock |
| `protocol.probe` handshake rejects old bridge | unit (mock bridge): simulate old bridge that returns unknown-method error for `protocol.probe`, assert MCP server disconnects with E_PROTOCOL_VERSION surfaced to next tool call |
| `protocol.probe` handshake succeeds against v2 bridge | unit (mock bridge): respond with `{ protocolVersion: "2", capabilities: [] }`, assert MCP server proceeds with subsequent tool calls |

---

## Out of Scope

- Bridge-side caching of disassembly / analysis (separate perf work)
- Multi-MCP-server coordination (still 1 server : N sessions)
- Persistent state across MCP server restarts
- Tool grouping / dynamic registration (MCP doesn't support it natively; revisit if SDK ever does)
- GUI-driven configuration UI for x64dbg-mcp itself

---

## Working notes

(stripped at ship)

- TLS callback detection — confirm whether `CB_LOADDLL` arrives before TLS callbacks fire, or if we need a different hook. May need to inspect x64dbg source to be sure.
- Default `timeoutMs` of 30s: arbitrary. Watch usage and tune.
- `recentEvents` size 50: arbitrary, revisit after first integration test.
- `execute_command` description has growth pressure (migration mapping in D9). If it exceeds 300 tokens, split out a separate `describe_commands` tool — but only after measuring real token impact.
- Existing `analyze_function` and `get_cross_references` are bridge-side; check they still work when state model changes.
- `collect_bp_args` reads stack/regs at the current BP — must keep working with the new "no separate set_breakpoint" world; agents will set BPs via execute_command then call `collect_bp_args` from the paused state.
- 30s terminated retention is a guess. If AI agents typically read state within 5 seconds of termination, we could shorten to 10s and reduce memory footprint. Defer measurement to post-1.2.0.
- Bridge crash mid-load (during `loading` state): implementer should mark as `terminated` with `terminationReason: "bridge_lost"`, then enter the retention window so AI agent can observe the failure.
- The three-layer (state / pauseReason / terminationReason) model intentionally duplicates info between `lastEvent` and the two reason fields. The reason fields are the "current" view (cleared on state transitions); `lastEvent` is "what just happened" (any kind); `recentEvents` is "what has been happening" (history). Each answers a different question.
- MCP notification method namespace: D7 uses `x64dbg/debugEvent` and `x64dbg/stateChange`. Verify at implementation time whether the MCP SDK requires the `notifications/` prefix (i.e. `notifications/x64dbg/debugEvent`) or accepts arbitrary method names. Adjust spec to match the SDK convention before plan freeze.
- Lifecycle tool implicit 60s timeout (D13) is not user-customizable. If autoAnalyze on huge binaries blows past 60s in practice, add an optional `loadTimeoutMs` parameter post-1.2.0.
- D2 `currentThreadId` / `currentPc` / `currentModule` semantics during `running` / `loading`: implementer should expose stale "last paused" values rather than nulls, so AI agents can still inspect the most recent context. Add doc comment on the type.
