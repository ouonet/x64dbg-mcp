# Multi-Session Support — Design Spec

**Date**: 2026-05-08
**Status**: Draft (pending implementation)
**Scope**: Allow a single x64dbg-mcp server to spawn and manage multiple
independent x64dbg instances, each debugging its own target program in parallel.

---

## 1. Architecture Overview

Today's server is built around two singletons: a single `BridgeClient` connected
to one fixed TCP port (`BRIDGE_PORT`, default 27042), and a single
`debuggerProcess` handle. The session manager exposes a `Map<id, Session>` but
hard-caps it at 1 entry, so the second `load_executable` call is rejected.

The new architecture replaces both singletons with **per-session resources**
owned by the `SessionManager`. One session ≡ one x64dbg process ≡ one bridge
TCP connection ≡ one allocated port. `terminate_session` reclaims all three.

```
Before: AI ↔ MCP server ↔ [bridge: 27042] ↔ [single x64dbg]

After:  AI ↔ MCP server ↔ ┬ [bridge: 51234] ↔ [x64dbg #A debugging calc.exe]
                          ├ [bridge: 60123] ↔ [x32dbg #B debugging mainfree.exe]
                          └ [bridge: 58901] ↔ [x64dbg #C attached to PID 1234]
```

### Design choices (decided during brainstorming)

| Question | Decision |
|----------|----------|
| Concurrency trigger | `load_executable` always spawns a fresh x64dbg (no implicit reuse). |
| Granularity | 1 session ≡ 1 instance. Terminating a session also kills its x64dbg. |
| Port allocation | Random high port (49152–65535), probed for availability. |
| Concurrency cap | `MAX_SESSIONS` from `.env`, default 5. |
| Shutdown | Kill all spawned x64dbg processes (existing `KEEP_DEBUGGER=1` honored). |

### Why no Python-bridge changes are required

The Python bridge plugin already reads `BRIDGE_PORT` from the process
environment. Each x64dbg instance is its own process with its own env. The
MCP server passes a per-spawn `BRIDGE_PORT` via `spawn(..., { env: ... })`, so
each plugin binds the right port automatically. No protocol or plugin code
changes.

---

## 2. Data Structures and Module Changes

### `src/types.ts`

```ts
export interface Session {
  id: string;
  pid: number;              // debuggee PID (target program)
  executable: string;
  architecture: "x86" | "x64";
  state: DebugState;
  bridgePort: number;       // NEW — TCP port owned by this session
  createdAt: number;
  lastActivity: number;
  breakpoints: Map<string, Breakpoint>;
  modules: ModuleInfo[];
}

export interface ServerConfig {
  // ...existing fields...
  maxSessions: number;      // NEW — MAX_SESSIONS env, default 5
}
```

### `src/bridge.ts`

Convert the singleton into a constructable client; remove the module-level
`bridge` export.

```ts
export class BridgeClient extends EventEmitter {
  constructor(private host: string, private port: number) { super(); }
  // existing connect/disconnect/request/call/drain methods unchanged
  // internal references to config.bridgeHost/bridgePort replaced with this.host/this.port
}
```

`launchAndConnect()` is removed — its responsibility (spawn x64dbg + connect)
is moved into `load_executable` so the orchestration owns the rollback path
(see §5).

### `src/bridgeRegistry.ts` (new)

Thin wrapper over `Map<sessionId, BridgeClient>` that auto-binds disconnect/
reconnect events with the session id in scope.

```ts
class BridgeRegistry {
  private clients = new Map<string, BridgeClient>();

  set(sessionId: string, client: BridgeClient): void {
    client.on("disconnected", () => {
      logger.error(`Bridge for session ${sessionId} disconnected — terminating`);
      sessions.terminate(sessionId);   // terminate() handles full cleanup
    });
    client.on("reconnected", () => logger.info(`Bridge ${sessionId} reconnected`));
    this.clients.set(sessionId, client);
  }

  get(sessionId: string): BridgeClient {
    const c = this.clients.get(sessionId);
    if (!c) throw new McpError(ErrorCode.E_SESSION_NOT_FOUND, `No bridge for session ${sessionId}`);
    return c;
  }

  async delete(sessionId: string): Promise<void> {
    const c = this.clients.get(sessionId);
    if (!c) return;
    this.clients.delete(sessionId);
    await c.drain(2_000);
    await c.disconnect();
  }

  list(): BridgeClient[] { return Array.from(this.clients.values()); }
}

export const bridges = new BridgeRegistry();

/** Convenience helper used everywhere a tool used to call `bridge.call(...)`. */
export function bridgeFor(sessionId: string): BridgeClient {
  return bridges.get(sessionId);
}
```

### `src/launcher.ts`

Replace single-process tracking with a `Map<sessionId, ChildProcess>` and add
port-aware launch/kill helpers + a port picker.

```ts
launchDebuggerOnPort(targetExe: string, port: number): Promise<{ arch, child }>;
launchDebuggerForAttachOnPort(pid: number, arch: "x86"|"x64", port: number): Promise<ChildProcess>;
killDebuggerForSession(sessionId: string): void;
killAllDebuggers(): void;       // replaces killDebugger()
pickFreePort(min=49152, max=65535, attempts=20): Promise<number>;
```

`pickFreePort` tries random candidates by binding `net.createServer()` and
listening; the first successful bind wins (close immediately and return the
port). Up to `attempts` retries before throwing `E_PORT_EXHAUSTED`.

The "if x64dbg already reachable, reuse it" shortcut is removed — multi-session
mode always spawns a new instance with its own env.

`spawn(...)` now passes per-launch env:

```ts
spawn(dbgExe, args, {
  detached: true,
  stdio: "ignore",
  windowsHide: false,
  env: { ...process.env, BRIDGE_PORT: port.toString() },
});
```

### `src/session.ts`

```ts
create(executable, architecture, pid, bridgePort): Session
// - check sessions.size < config.maxSessions  (replaces hard-coded ≤1)
// - throws E_SESSION_LIMIT with the active session list when over cap

terminate(id): Promise<void>
// - bridges.delete(id)             // disconnects bridge socket
// - killDebuggerForSession(id)     // kills owning x64dbg process
// - sessions.delete(id)
```

GC reaper (`collectExpired`) now calls the same `terminate(id)` — full cleanup,
not just state mutation.

### `src/config.ts`

Add `maxSessions` parsing:

```ts
maxSessions: parseEnvInt(process.env.MAX_SESSIONS, 5),
```

`bridgePort` is kept in config as a default starting point only for legacy
single-port flows (e.g. doctor command), and as the value reported by `setup`.
It is no longer the singleton port for live sessions.

---

## 3. Tool Layer Changes

Mechanical replacement: `bridge.call(...)` → `bridgeFor(sessionId).call(...)`.
Every tool already takes `sessionId` as its first parameter. The bridge
request payload still carries `sessionId` as a field for symmetry with the
legacy plugin handlers, but actual TCP routing happens MCP-side via the
registry.

### Tools needing more than mechanical changes

| Tool | Change |
|------|--------|
| `load_executable` | Remove "≤1 session" check. New flow: pickFreePort → launchDebuggerOnPort → new BridgeClient → connect → bridges.set → bridge.call("debug.load") → sessions.create. Enforces `MAX_SESSIONS`. Rollback on any failure (see §5). |
| `attach_to_process` | Same flow as `load_executable`, with `launchDebuggerForAttachOnPort` and `debug.attach`. |
| `terminate_session` | `bridgeFor(id).call("debug.stop")` → `sessions.terminate(id)` (which now does full cleanup). |
| `detach_session` | Like terminate but uses `debug.detach`. |
| `close_debugger` | Iterate sessions and call `terminate(id)`; with `force=true`, also `taskkill` as a sweep. |
| `get_status` | Top-level `bridgeConnected` field is removed (no global bridge). Each session reports its own bridge connection status. |
| `list_sessions` | `toJSON()` exposes `bridgePort`. |

### Per-session bridge connectivity in `get_status`

```ts
// Defensive: during terminate(), the bridge entry is removed before the
// session entry, leaving a small window where bridgeFor() would throw.
let bridgeConnected = false;
try { bridgeConnected = bridges.get(id).isConnected; } catch { /* mid-teardown */ }

status.session = {
  id, state, executable, architecture, pid,
  bridgePort: s.bridgePort,
  bridgeConnected,
  breakpointCount: s.breakpoints.size,
};
```

---

## 4. Server Lifecycle

### Startup (`src/server.ts`)

The server no longer connects a global bridge at startup; it starts in a
zero-session, zero-x64dbg state and waits for the first `load_executable`.

```ts
async function main() {
  logger.info("x64dbg MCP Server starting …");
  // No bridge.connect() here.
  sessions.start();
  // Start MCP transport (stdio or HTTP), register tools.
}
```

### Shutdown

SIGINT / SIGTERM / stdin close all run the same shutdown handler:

```ts
async function shutdown() {
  await closeTransport();

  // Drain and disconnect each session's bridge in parallel
  await Promise.all(sessions.list().map(async (s) => {
    try {
      const b = bridges.get(s.id);
      await b.drain(2_000);
    } catch { /* missing bridge → fine */ }
    await sessions.terminate(s.id);  // disconnects + kills x64dbg
  }));

  sessions.stop();
  killAllDebuggers();   // safety sweep; KEEP_DEBUGGER=1 honored
  process.exit(0);
}
```

### Bridge events

Per-session events are bound by `BridgeRegistry.set()` (see §2). A single
session's `disconnected` event triggers only that session's `terminate()`;
other sessions are unaffected.

---

## 5. Error Handling and Edge Cases

### Resource ownership during `load_executable`

The orchestration is structured so each step's failure cleans up only what it
already acquired:

```
1. pickFreePort()             → port             (no resource yet)
2. launchDebuggerOnPort       → child            (owns child locally)
   on failure: throw, no cleanup needed
3. const b = new BridgeClient(host, port); await b.connect()
   on failure: child.kill(); throw
4. await b.call("debug.load") → debuggee live
   on failure: b.disconnect(); child.kill(); throw
5. const s = sessions.create(exe, arch, pid, port)
   bridges.set(s.id, b)        → both registries take ownership
   from this point, sessions.terminate(s.id) is the canonical cleanup path
```

Steps 2–4 hold the `child` and the local `BridgeClient` as plain variables —
the registries are not yet involved, so `bridgeFor(sessionId)` is not callable
yet (and not needed: the orchestration code already has the local reference).
Resources are registered with `SessionManager` and `BridgeRegistry`
**only after** step 5; GC never sees half-built sessions.

### `MAX_SESSIONS` exceeded

`load_executable` and `attach_to_process` check the cap before step 1. When
exceeded, return `E_SESSION_LIMIT` with the list of active sessions
(id + executable + state) so the AI can choose which to terminate.

### Port exhaustion

`pickFreePort` retries up to 20 random ports. Failure mode is `E_PORT_EXHAUSTED`
— extremely unlikely with `MAX_SESSIONS=5` in a 16K-port range; serves as a
safety net rather than a real concern.

### Bridge dispatch concurrency

x64dbg internals are not thread-safe; the Python plugin already serializes
handlers with `_dispatch_lock`. Each x64dbg has its own dispatch lock, so
**inter-session calls run in parallel** without contention. Within a session,
serialization is unchanged (pending `Map<requestId>` plus UUIDs).

### Per-session disconnect

`disconnected` for one BridgeClient terminates only that session and its
x64dbg. The other sessions continue to operate.

---

## 6. Multi-Session Integration Test

### Goal

Drive two real Win32 PE programs (an HTTP server and an HTTP client) under one
MCP server, in parallel sessions, with breakpoints set on each, and verify
session isolation, parallel dispatch, and clean teardown.

### Fixtures (`test/fixtures/`)

- `http_server.c` — Winsock minimal server: `socket → bind → listen → accept → recv → send "PONG\r\n" → closesocket → exit`. Listens on `127.0.0.1:18080`.
- `http_client.c` — `socket → connect("127.0.0.1:18080") → send "PING\r\n" → recv → exit(success/failure)`.
- `CMakeLists.txt` — builds `http_server.exe` and `http_client.exe` (x64, links `ws2_32`).
- Constraints: < 100 LoC each, plain Win32 API, no third-party deps.

### npm scripts

```json
{
  "build:fixtures": "cmake -S test/fixtures -B test/fixtures/build -A x64 && cmake --build test/fixtures/build --config Release",
  "test:integration": "npx tsx --test test/integration/multi-session.test.ts"
}
```

`npm test` keeps running only the basic suite. CI / local devs run
`npm run test:integration` (requires MSVC + an installed x64dbg).

### `test/integration/multi-session.test.ts`

Calls registered tool handlers directly (bypassing the MCP wire protocol, to
keep the test focused on multi-session routing rather than transport). Exposes
the handler map from `mcpServer.ts` for in-process invocation.

```
1.  Start MCP server in-process.
2.  sA = await load_executable("http_server.exe")   // session A, port P_A
    sB = await load_executable("http_client.exe")   // session B, port P_B
3.  Assert: sessions.list().length === 2 and P_A !== P_B.
4.  set_breakpoint(sA, "ws2_32.accept",  type=software)
    set_breakpoint(sB, "ws2_32.connect", type=software)
5.  Invoke continue_execution(sA) and continue_execution(sB) in parallel
    via Promise.all  → verifies cross-session calls are not serialized.
6.  Assert list_breakpoints(sA).hitCount(accept)  >= 1
            list_breakpoints(sB).hitCount(connect) >= 1
7.  continue_execution(sA), continue_execution(sB) again to let PING/PONG
    exchange complete.
8.  Wait for both debuggees to exit naturally (state → terminated).
9.  terminate_session(sA), terminate_session(sB).
10. Assert: both spawned x64dbg processes are gone (poll `tasklist` or check
    exit code on each tracked ChildProcess); both ports are free
    (re-bind succeeds).
```

### Isolation assertions

- Step 4: `list_breakpoints(sA)` does not contain `connect`; `list_breakpoints(sB)` does not contain `accept`.
- Step 5: `Promise.all` completes without one call blocking on the other (timestamps recorded; max overlap latency < single call latency).
- Step 9 partial: terminate only `sA` first, then verify `get_status(sB)` still works and reports `bridgeConnected: true`. Then terminate `sB`.

### Graceful degradation

On test startup, check that fixtures exist. If missing:

```ts
if (!fs.existsSync(serverExe) || !fs.existsSync(clientExe)) {
  t.skip("fixtures not built — run `npm run build:fixtures` first");
  return;
}
```

---

## 7. Out of Scope

- Reusing idle x64dbg instances across sessions (chose simpler 1:1 model).
- Persisting session state across MCP server restarts.
- Cross-session debugging features (e.g. shared symbol cache).
- Auto-allocating sequential ports (chose random high ports).
- Changes to the Python bridge plugin or the `BRIDGE_PROTOCOL_VERSION`.
