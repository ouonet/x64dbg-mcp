# MCP Shell Architecture — Implementation Plan

**Spec**: `docs/staging/specs/2026-05-09-mcp-shell-architecture.md`
**Target**: v1.2.0 (breaking change)
**Branch**: `feature/mcp-shell-architecture`

Each task is ≤ 60 min, leaves the repo green, and references a spec decision (D1–D15) for acceptance.

---

- [x] T1: Types and error codes
  goal:       Establish the type vocabulary and error codes that every later task depends on.
  files:      `src/types.ts`, `src/errors.ts`
  acceptance: `npx tsc --noEmit` passes; unit test asserts new ErrorCode values are unique + `PauseReason` / `TerminationReason` / `DebugEventKind` / `bpType` / `bpKind` enums match D3 exactly.
  spec:       D3 (enums), D10 (error codes)

- [x] T2: Bridge — register all x64dbg callbacks
  goal:       Hook every callback listed in D3 sources; capture event payloads into a per-session in-memory log (no push channel yet).
  files:      `plugin/x64dbg_mcp_bridge.py`, `plugin/x64dbg_bridge_sdk.py`
  acceptance: `python plugin/tests/test_bridge.py` includes a new offline test that synthesizes each callback and asserts a `DebugEvent` shape is recorded.
  spec:       D3 (source callbacks), D4 (ring buffer)

- [x] T3: Bridge — state machine + event ring buffer (50 entries)
  goal:       Drive `state` / `pauseReason` / `terminationReason` from callbacks; maintain a 50-entry ring buffer; expose snapshot via a new `state.get` bridge request.
  files:      `plugin/x64dbg_mcp_bridge.py`
  acceptance: Offline test feeds a synthetic event sequence (system_bp → run → bp → run → exit) and asserts state transitions, `lastEvent`, and `recentEvents.length === 50` after overflow.
  spec:       D2 (state machine), D4 (buffer)

- [x] T4: Bridge — classification + coalescing rules
  goal:       Implement D3 classification rules 1–8: hardcoded int 3 routing, HW/mem BP routing, temporary BP detection, exception-BP coalescing, DLL-BP coalescing, manual-pause catch-all.
  files:      `plugin/x64dbg_mcp_bridge.py`
  acceptance: Offline test asserts each of the 8 rules produces the expected `DebugEvent.kind` / `bpType` / `bpKind` on synthetic callback sequences.
  spec:       D3 (classification rules)

- [x] T5: Bridge — protocol v2 + `protocol.probe` + reject v1
  goal:       Bump `BRIDGE_PROTOCOL_VERSION` to `"2"`; add `protocol.probe` request handler returning `{ protocolVersion, capabilities }`; reject any request with `protocolVersion != "2"` via `E_PROTOCOL_VERSION`.
  files:      `plugin/x64dbg_mcp_bridge.py`, `plugin/x64dbg_bridge_sdk.py`
  acceptance: Offline test sends `protocol.probe` and asserts response shape; sends `{ protocolVersion: "1", method: "debug.load" }` and asserts `E_PROTOCOL_VERSION` error.
  spec:       D10

- [x] T6: Bridge — unsolicited event push channel
  goal:       Emit `{ type: "debugEvent", event }` and `{ type: "stateChange", state }` frames on the existing TCP socket whenever state/event changes; never coalesce in the wire layer.
  files:      `plugin/x64dbg_mcp_bridge.py`
  acceptance: Offline test wires a fake socket, fires 3 callbacks, asserts 3 `debugEvent` frames + matching `stateChange` frames are written; assert frames have no `id` field.
  spec:       D11

- [x] T7: MCP — `BridgeClient` event dispatch + `protocol.probe` handshake
  goal:       Read unsolicited frames; route by `type` to `on("debugEvent")` / `on("stateChange")` emitters; on `connect()` issue `protocol.probe` and disconnect with `E_PROTOCOL_VERSION` on mismatch / old bridge.
  files:      `src/bridge.ts`
  acceptance: Unit test with mock TCP server sends mixed response + event frames, asserts correct routing; handshake test against a mock that returns old-style error → asserts disconnect.
  spec:       D7, D10, D11

- [x] T8: MCP — `SessionManager` state model + state-change CV
  goal:       Extend `Session` with `state`, `pauseReason`, `terminationReason`, `lastEvent`, `recentEvents`; wire `BridgeClient` events to update the session; expose a per-session state-change condition variable distinct from the dispatch lock.
  files:      `src/session.ts`, `src/types.ts`
  acceptance: Unit test simulates events via the mock bridge and asserts D2 invariants (pauseReason iff paused, etc.); CV wakes multiple waiters on the same transition.
  spec:       D2, D4, D6

- [x] T9: MCP — terminated session 30 s retention
  goal:       Add `terminated` retention window; read tools succeed during the window; write/execution tools fail with `E_SESSION_TERMINATED`; clock starts at termination (not at last access); GC reaper deletes after 30 s.
  files:      `src/session.ts`
  acceptance: Unit (fast clock): simulate terminated, advance 29 s → readable; advance to 31 s → reaped; calls during window do not extend retention.
  spec:       D15

- [x] T10: MCP — remove 7 deprecated tools
  goal:       Delete `set_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `run_to_address`, `set_register`, `switch_thread`, `trace_execution`. No deprecation shims.
  files:      `src/tools/debug.ts`, `src/tools/memory.ts`, `src/tools/analysis.ts`, `src/mcpServer.ts`
  acceptance: Unit test enumerates registered tools and asserts these 7 are absent; build passes.
  spec:       D1, D9

- [x] T11: MCP — execute_command description update
  goal:       Rewrite `execute_command`'s Zod description to include the full D9 migration mapping (breakpoints, conditional BPs, run-to, state manipulation, tracing, link to upstream docs); keep ≤ 300 tokens.
  files:      `src/tools/debug.ts`
  acceptance: Unit test asserts description contains key migration strings (`bp <addr>`, `bpcond`, `tc <expr>`, `r <reg>=<value>`); token-count assertion ≤ 300.
  spec:       D9, D12

- [x] T12: MCP — execution tools sync/async envelope
  goal:       Rewrite `continue_execution`, `step_into`, `step_over`, `step_out`, `pause_execution` to accept `{ async?, timeoutMs? }` and return `{ timedOut, ...stateSnapshot }`; sync waits on the state CV; async returns immediately; `pause_execution` returns immediately if already paused.
  files:      `src/tools/debug.ts`
  acceptance: Unit (mock bridge): each tool returns the envelope shape; timeout assertion within budget; concurrent execution + wait_for_state on same session does not deadlock.
  spec:       D5

- [x] T13: MCP — lifecycle tool returns + 60 s safety timeout
  goal:       Rewrite `load_executable` / `attach_to_process` to wait per D13 table (entry BP / running / system BP / crash / exit); implement 60 s safety timeout returning `timedOut: true`; populate `recentEvents` with full load trail.
  files:      `src/tools/debug.ts`
  acceptance: Unit (mock bridge) drives each row of D13 table and asserts envelope shape; timeout case asserts `timedOut: true` + `state: "loading"` + `pauseReason: null`.
  spec:       D13

- [x] T14: MCP — terminate / detach idempotency + cascade
  goal:       `terminate_session` and `detach_session` are idempotent (no-op success when already terminated, preserve `terminationReason`); partial cleanup downgrade `terminationReason` to `unknown`.
  files:      `src/tools/debug.ts`, `src/session.ts`
  acceptance: Unit (mock bridge) calls each tool twice → second call succeeds; partial failure case asserts `terminationReason === "unknown"` and tool still returns success.
  spec:       D14

- [x] T15: MCP — read tools state snapshot
  goal:       `get_status` returns the full D2 snapshot including `pauseReason`, `terminationReason`, `lastEvent`, `recentEvents`; `list_sessions` includes terminated sessions during the retention window.
  files:      `src/tools/debug.ts`
  acceptance: Unit asserts D2 shape; integration test asserts list_sessions includes a recently-terminated session within 30 s.
  spec:       D2, D15

- [x] T16: MCP — `wait_for_state` tool
  goal:       Implement `wait_for_state(sessionId, { expect, timeoutMs?, pauseReasonFilter?, terminationReasonFilter? })`. Use the per-session CV from T8; return immediately when already matching; empty filter array matches nothing.
  files:      `src/tools/debug.ts`, `src/mcpServer.ts`
  acceptance: Unit: condition already matching returns < 10 ms; timeout returns `matched: false`; filter `[]` always times out; concurrent waiters all wake on same transition.
  spec:       D6

- [x] T17: MCP — `save_memory_dump` + `create_minidump` tools
  goal:       Implement both new structured-I/O tools; enforce path invariants (absolute, parent exists, not a directory, no trailing separator); size cap 256 MB on `save_memory_dump`; overwrite silently.
  files:      `src/tools/memory.ts`, `src/mcpServer.ts`
  acceptance: Unit: path/size validation cases; integration: paused fixture writes 64 bytes → file exists, bytesWritten matches; create_minidump "normal" < "full" size.
  spec:       D8

- [x] T18: MCP — notification emission
  goal:       Emit MCP notifications `x64dbg/debugEvent` (per event) and `x64dbg/stateChange` (per transition); namespace verified against MCP SDK requirements before commit (resolve working note).
  files:      `src/mcpServer.ts`, `src/bridgeRegistry.ts`
  acceptance: Unit (mock MCP transport): mock bridge fires 5 events → 5 debugEvent notifications received; non-pausing event does not fire stateChange notification.
  spec:       D7

- [x] T19: Update existing tests to new envelope shapes
  goal:       Update `test/basic.test.ts` and `test/integration/multi-session.test.ts` to assert new `{ timedOut, ...stateSnapshot }` envelopes; remove assertions on deleted tools; assert `bpKind: "user"` on BPs.
  files:      `test/basic.test.ts`, `test/integration/multi-session.test.ts`
  acceptance: `npm test` and `npm run test:integration` pass.
  spec:       D1, D2, D5, D13

- [x] T20: New integration tests for state observability
  goal:       Add tests covering: TLS-callback pause, hardcoded `int 3`, HW/mem/DLL BP classifications, exception-BP coalescing, retention-window readability, wait_for_state immediate-match + filter, concurrent wait + continue, save_memory_dump end-to-end, lifecycle 60 s timeout.
  files:      `test/integration/state-observability.test.ts` (new), `test/fixtures/*.c` (new fixtures: int3.exe, exception-bp.exe), `test/fixtures/CMakeLists.txt`
  acceptance: `npm run build:fixtures && npm run test:integration` passes with the new test file included.
  spec:       D3, D6, D8, D13, D15

- [x] T21: Docs + .env.example + execute_command final review
  goal:       Update README architecture / capabilities / tools count to 38; CHANGELOG `[Unreleased]` with all breaking changes; .env.example unchanged (no new vars); CLAUDE.md project section reflects three-layer state model and removed tools.
  files:      `README.md`, `CHANGELOG.md`, `.env.example`, `CLAUDE.md`
  acceptance: README tool count says 38; CHANGELOG lists all 7 removed tools and 3 new tools; CLAUDE.md mentions PauseReason / TerminationReason / wait_for_state.
  spec:       D1, D9

- [x] T22: Version bump + final green
  goal:       Bump `package.json` to `1.2.0`; bump bridge `BRIDGE_PROTOCOL_VERSION` constant to `"2"`; verify `npm test`, `npm run test:integration`, `python plugin/tests/test_bridge.py`, `npm run lint` all green.
  files:      `package.json`, `plugin/x64dbg_mcp_bridge.py`, `CHANGELOG.md`
  acceptance: Full test matrix green; `git diff` shows version + protocol bumps; CHANGELOG `[Unreleased]` becomes `[1.2.0] - YYYY-MM-DD`.
  spec:       D10

---

## Parallelism hints

- [parallel] T2, T3, T4, T5, T6 — all Python bridge work, but T3/T4 both touch state/event paths in `x64dbg_mcp_bridge.py`. Dispatch with file-level coordination if subagents conflict; otherwise serialize within Python work.
- [parallel] T10, T11 — both touch `src/tools/debug.ts`; serialize.
- [parallel] T12, T13, T14, T15, T16 — all in `src/tools/debug.ts` + `src/session.ts`; **serialize** to avoid merge conflicts.
- [parallel] T17 — `src/tools/memory.ts` only; safe to parallelize with T12–T16.
- [parallel] T19, T20 — separate test files; can run in parallel after T1–T18 are done.

In practice the bulk of MCP work shares two files (`debug.ts`, `session.ts`), so most tasks are serial. Bridge work (Python) is independent of MCP work after T1 / T7 contracts are agreed.

---

## Hand-off

22 tasks, ~14–22 hours of work, mostly serial due to shared-file constraints. Recommend `tdd` (single session, file-by-file) rather than `subagents` (parallel) given the file-overlap pattern. The Python bridge milestones (T2–T6) could be lifted out to a subagent in parallel with the MCP server work (T7–T18) if developer wants to use the time, but the in-flight risk is moderate.
