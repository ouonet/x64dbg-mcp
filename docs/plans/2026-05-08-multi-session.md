# Multi-Session Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow one x64dbg-mcp server to spawn and manage multiple x64dbg instances in parallel, each with its own bridge port and session, debugging different programs simultaneously.

**Architecture:** Replace the singleton `BridgeClient` and `debuggerProcess` with per-session resources keyed by `sessionId`. Each `load_executable` call picks a free random high port (49152–65535), spawns a fresh x64dbg with `BRIDGE_PORT` env override, opens a dedicated TCP bridge, and records all three in `SessionManager` + `BridgeRegistry`. `terminate_session` reclaims them in lock-step.

**Tech Stack:** TypeScript (Node.js), `net.Server` for port probing, child_process `spawn` with per-launch env, MCP SDK, plain Win32 C for fixtures (CMake build).

**Spec:** See `docs/specs/2026-05-08-multi-session-design.md`.

---

## File Structure

**Create:**
- `src/bridgeRegistry.ts` — per-session BridgeClient registry + `bridgeFor()` helper
- `test/fixtures/http_server.c` — minimal Winsock echo server (PE x64)
- `test/fixtures/http_client.c` — minimal Winsock client (PE x64)
- `test/fixtures/CMakeLists.txt` — fixture build
- `test/fixtures/.gitignore` — ignore `build/` output
- `test/integration/multi-session.test.ts` — two-session HTTP integration test

**Modify:**
- `src/types.ts` — add `bridgePort` to Session, `maxSessions` to ServerConfig
- `src/config.ts` — parse `MAX_SESSIONS` env (default 5)
- `src/errors.ts` — add `E_PORT_EXHAUSTED`
- `src/bridge.ts` — `BridgeClient` constructor takes `host`/`port`; drop singleton export
- `src/launcher.ts` — `pickFreePort`, port-aware spawn, per-session `ChildProcess` map
- `src/session.ts` — drop ≤1 cap, store `bridgePort`, full cleanup in `terminate()`
- `src/server.ts` — drop startup `bridge.connect()`, parallel shutdown
- `src/tools/debug.ts` — `bridgeFor(sessionId)` everywhere; refactor `load_executable` and `attach_to_process` orchestration
- `src/tools/memory.ts` — `bridgeFor(sessionId)` everywhere
- `src/tools/analysis.ts` — `bridgeFor(sessionId)` everywhere
- `src/tools/security.ts` — `bridgeFor(sessionId)` everywhere
- `src/mcpServer.ts` — export tool handler map for in-process integration tests (if needed)
- `test/basic.test.ts` — update assertions for new `BridgeClient` constructor & MAX_SESSIONS=5
- `package.json` — add `build:fixtures` and `test:integration` scripts
- `.env.example` — document `MAX_SESSIONS`

---

## Task 1: Add type fields and config

**Files:**
- Modify: `src/types.ts:7-17` and `src/types.ts:309-325`
- Modify: `src/config.ts:119-134`

- [ ] **Step 1: Update `Session` interface — add `bridgePort` field**

Edit `src/types.ts`, replace the `Session` interface:

```ts
export interface Session {
  id: string;
  pid: number;
  executable: string;
  architecture: "x86" | "x64";
  state: DebugState;
  bridgePort: number;
  createdAt: number;
  lastActivity: number;
  breakpoints: Map<string, Breakpoint>;
  modules: ModuleInfo[];
}
```

- [ ] **Step 2: Update `ServerConfig` interface — add `maxSessions`**

Edit `src/types.ts`, in the `ServerConfig` interface, add `maxSessions: number;` after the existing `sessionTimeoutMs` field:

```ts
export interface ServerConfig {
  x64dbgPath: string;
  bridgeHost: string;
  bridgePort: number;
  bridgeAuthToken: string;
  mcpTransport: "stdio" | "streamable-http";
  mcpHttpHost: string;
  mcpHttpPort: number;
  logLevel: "error" | "warn" | "info" | "debug";
  sessionTimeoutMs: number;
  maxSessions: number;
  maxDisasmInstructions: number;
  maxTraceInstructions: number;
  maxSearchResults: number;
  maxStringLength: number;
}
```

- [ ] **Step 3: Parse `MAX_SESSIONS` in config**

Edit `src/config.ts`. In the returned object inside `loadConfig()`, add the field next to `sessionTimeoutMs`:

```ts
  return {
    x64dbgPath,
    bridgeHost: process.env.BRIDGE_HOST || "127.0.0.1",
    bridgePort: parseEnvInt(process.env.BRIDGE_PORT, 27042),
    bridgeAuthToken,
    mcpTransport: normalizeMcpTransport(process.env.MCP_TRANSPORT),
    mcpHttpHost: process.env.MCP_HTTP_HOST || "127.0.0.1",
    mcpHttpPort: parseEnvInt(process.env.MCP_HTTP_PORT, 3602),
    logLevel: (process.env.LOG_LEVEL as ServerConfig["logLevel"]) || "info",
    sessionTimeoutMs: parseEnvInt(process.env.SESSION_TIMEOUT_MS, 3_600_000),
    maxSessions: parseEnvInt(process.env.MAX_SESSIONS, 5),
    maxDisasmInstructions: parseEnvInt(process.env.MAX_DISASM_INSTRUCTIONS, 500),
    maxTraceInstructions: parseEnvInt(process.env.MAX_TRACE_INSTRUCTIONS, 10_000),
    maxSearchResults: parseEnvInt(process.env.MAX_SEARCH_RESULTS, 1000),
    maxStringLength: parseEnvInt(process.env.MAX_STRING_LENGTH, 256),
  };
```

- [ ] **Step 4: Build to verify type compiles**

Run: `npm run build`
Expected: PASS, no TS errors. (Sessions created elsewhere will still compile because we'll update them in Task 6.)

Wait — `Session` requires `bridgePort` now, so `session.create()` calls won't compile. To keep this task purely additive, also bump `session.ts` `create()` to accept and pass the field.

- [ ] **Step 5: Tweak `SessionManager.create()` signature**

Edit `src/session.ts`, change the `create` method:

```ts
  create(executable: string, architecture: "x86" | "x64", pid: number, bridgePort = 0): Session {
    if (this.sessions.size >= 1) {
      throw new McpError(
        ErrorCode.E_SESSION_LIMIT,
        "Only one active debugging session is supported. Terminate the current session before loading a new executable."
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      pid,
      executable,
      architecture,
      state: "idle",
      bridgePort,
      createdAt: now,
      lastActivity: now,
      breakpoints: new Map(),
      modules: [],
    };

    this.sessions.set(id, session);
    logger.info(`Session created: ${id} → ${executable} (${architecture})`);
    return session;
  }
```

The default `bridgePort = 0` keeps existing callers compiling; Task 6 will tighten this.

- [ ] **Step 6: Run `npm run build`**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add src/types.ts src/config.ts src/session.ts
rtk git commit -m "feat(types): add Session.bridgePort and config.maxSessions"
```

---

## Task 2: Add `E_PORT_EXHAUSTED` error code

**Files:**
- Modify: `src/errors.ts:13-32`

- [ ] **Step 1: Write a test that the new code is unique**

Edit `test/basic.test.ts` — extend the existing `describe("ErrorCode and McpError")` block by adding a new test after the existing "all ErrorCode values are unique strings" test:

```ts
  test("E_PORT_EXHAUSTED is registered", () => {
    assert.equal(ErrorCode.E_PORT_EXHAUSTED, "E_PORT_EXHAUSTED");
  });
```

- [ ] **Step 2: Run tests — verify FAIL**

Run: `npm test`
Expected: FAIL on the new test ("E_PORT_EXHAUSTED is registered").

- [ ] **Step 3: Add the new error code**

Edit `src/errors.ts`, add inside the `ErrorCode` object after `E_MODULE_NOT_FOUND`:

```ts
  /** No free TCP port could be allocated for a new bridge. */
  E_PORT_EXHAUSTED: "E_PORT_EXHAUSTED",
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `npm test`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
rtk git add src/errors.ts test/basic.test.ts
rtk git commit -m "feat(errors): add E_PORT_EXHAUSTED for port allocator"
```

---

## Task 3: `pickFreePort()` helper in launcher

**Files:**
- Modify: `src/launcher.ts:1-14, 322+`
- Test: `test/basic.test.ts` (new describe block after launcher tests)

- [ ] **Step 1: Write failing test for `pickFreePort`**

Edit `test/basic.test.ts`. After the `describe("resolveDebuggerExe", ...)` block, add:

```ts
describe("pickFreePort", async () => {
  const { pickFreePort } = await importFresh<
    typeof import("../src/launcher.js")
  >("src/launcher.ts");

  test("returns a port in the high range", async () => {
    const p = await pickFreePort();
    assert.ok(p >= 49152 && p <= 65535, `port out of range: ${p}`);
  });

  test("returned port is actually bindable", async () => {
    const p = await pickFreePort();
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(p, "127.0.0.1", () => {
        srv.close((err) => err ? reject(err) : resolve());
      });
    });
  });

  test("two consecutive calls return different ports (high probability)", async () => {
    // Random allocation should rarely collide; this is a probabilistic check.
    const ports = new Set<number>();
    for (let i = 0; i < 5; i++) ports.add(await pickFreePort());
    assert.ok(ports.size >= 4, `expected ≥4 distinct ports, got ${ports.size}`);
  });
});
```

- [ ] **Step 2: Run tests — verify FAIL**

Run: `npm test`
Expected: FAIL with "pickFreePort is not exported" (TS module load error).

- [ ] **Step 3: Implement `pickFreePort` in launcher**

Edit `src/launcher.ts`. Add the import and helper near the top (after the existing imports):

```ts
import { McpError, ErrorCode } from "./errors.js";
```

Then add this exported function (place it after `detectPEArchitecture`, before `resolveDebuggerExe`):

```ts
/**
 * Pick a free TCP port in the dynamic / private range (49152–65535).
 * Probes by binding a throwaway server; the first successful bind wins.
 *
 * @throws McpError(E_PORT_EXHAUSTED) after `attempts` random failures.
 */
export async function pickFreePort(
  min = 49152,
  max = 65535,
  attempts = 20,
): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const candidate = Math.floor(min + Math.random() * (max - min + 1));
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => { srv.close(); resolve(false); });
      srv.listen(candidate, "127.0.0.1", () => {
        srv.close(() => resolve(true));
      });
    });
    if (ok) return candidate;
  }
  throw new McpError(
    ErrorCode.E_PORT_EXHAUSTED,
    `Could not allocate a free TCP port in [${min}, ${max}] after ${attempts} attempts`,
  );
}
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `npm test`
Expected: PASS, all three new tests green.

- [ ] **Step 5: Commit**

```bash
rtk git add src/launcher.ts test/basic.test.ts
rtk git commit -m "feat(launcher): add pickFreePort helper for high-range allocation"
```

---

## Task 4: Refactor `BridgeClient` constructor to accept host/port

**Files:**
- Modify: `src/bridge.ts:33-49, 64-107, 348-349`
- Modify: `test/basic.test.ts` (offline + mock describes)

- [ ] **Step 1: Update `BridgeClient` to take host/port in constructor**

Edit `src/bridge.ts`. Replace the class declaration up to and including the `connect()` method:

```ts
export class BridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending = new Map<string, PendingResolver>();
  private connected = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: string = config.bridgeHost,
    private readonly port: number = config.bridgePort,
  ) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get bridgePort(): number {
    return this.port;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      return new Promise<void>((resolve, reject) => {
        this.once("connected-result", (err?: Error) => {
          if (err) reject(err); else resolve();
        });
      });
    }
    this.connecting = true;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connecting = false;
        this.cleanup();
        const err = new Error("Bridge connection timed out");
        this.emit("connected-result", err);
        reject(err);
      }, CONNECT_TIMEOUT_MS);

      this.socket = new net.Socket();

      this.socket.on("connect", () => {
        clearTimeout(timer);
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.buffer = "";
        logger.info(`Bridge connected to ${this.host}:${this.port}`);
        this.emit("connected-result");
        resolve();
      });

      this.socket.on("data", (chunk) => this.onData(chunk));

      this.socket.on("error", (err) => {
        clearTimeout(timer);
        logger.error(`Bridge socket error: ${err.message}`);
        if (!this.connected) {
          this.connecting = false;
          this.emit("connected-result", err);
          reject(err);
        }
      });

      this.socket.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.rejectAllPending("Bridge connection closed");
        if (wasConnected) {
          logger.warn("Bridge connection closed, scheduling reconnect");
          this.scheduleReconnect();
        }
      });

      this.socket.connect(this.port, this.host);
    });
  }
```

- [ ] **Step 2: Update `scheduleReconnect()` to call `this.connect()` only**

The existing implementation already calls `this.connect()` (no host/port hardcoded), so leave it. Verify by reading `src/bridge.ts:171-178`.

- [ ] **Step 3: Drop the singleton export**

At the bottom of `src/bridge.ts`, remove the `export const bridge = new BridgeClient();` line. (Tasks 7–10 will replace its uses.)

Replace it with a comment:

```ts
// NOTE: There is intentionally no singleton bridge instance. Each session owns
// its own BridgeClient — see src/bridgeRegistry.ts.
```

This **will break compilation** in tools/server until Task 5+ lands. To avoid a long red window, **temporarily keep the singleton** and remove it in Task 11. Replace the previous instruction with:

Keep:

```ts
/** Singleton bridge instance (deprecated — kept for transitional compat; will be removed in Task 11). */
export const bridge = new BridgeClient();
```

- [ ] **Step 4: Update bridge offline tests**

Edit `test/basic.test.ts`, in the `describe("BridgeClient (offline)")` block, change the three `new BridgeClient()` calls to pass explicit host/port (any unused port is fine since these tests verify offline behavior):

```ts
  test("isConnected is false before connect()", () => {
    const b = new BridgeClient("127.0.0.1", 19999);
    assert.equal(b.isConnected, false);
  });

  test("request() throws when not connected", async () => {
    const b = new BridgeClient("127.0.0.1", 19999);
    await assert.rejects(
      () => b.request("test.method", {}),
      /Bridge is not connected/
    );
  });

  test("call() throws when not connected", async () => {
    const b = new BridgeClient("127.0.0.1", 19999);
    await assert.rejects(
      () => b.call("test.method", {}),
      /Bridge is not connected/
    );
  });
```

(The existing "raw TCP" test does not use BridgeClient, leave it.)

- [ ] **Step 5: Run tests — verify PASS**

Run: `npm test`
Expected: PASS, all bridge offline tests green; build clean.

- [ ] **Step 6: Commit**

```bash
rtk git add src/bridge.ts test/basic.test.ts
rtk git commit -m "refactor(bridge): BridgeClient takes host/port via constructor"
```

---

## Task 5: Add `BridgeRegistry` and `bridgeFor()` helper

**Files:**
- Create: `src/bridgeRegistry.ts`
- Test: `test/basic.test.ts` (new describe block)

- [ ] **Step 1: Write failing test for `BridgeRegistry`**

Edit `test/basic.test.ts`. Append a new describe block after the existing `"BridgeClient (mock TCP server)"` block:

```ts
describe("BridgeRegistry", async () => {
  const { BridgeRegistry, bridgeFor } = await importFresh<
    typeof import("../src/bridgeRegistry.js")
  >("src/bridgeRegistry.ts");
  const { BridgeClient } = await importFresh<
    { BridgeClient: typeof import("../src/bridge.js").BridgeClient }
  >("src/bridge.ts");

  test("set/get round-trip", () => {
    const r = new BridgeRegistry();
    const c = new BridgeClient("127.0.0.1", 19998);
    r.set("sess-1", c);
    assert.equal(r.get("sess-1"), c);
  });

  test("get throws E_SESSION_NOT_FOUND for unknown id", () => {
    const r = new BridgeRegistry();
    assert.throws(() => r.get("ghost"), /E_SESSION_NOT_FOUND|No bridge for/);
  });

  test("delete removes the entry", async () => {
    const r = new BridgeRegistry();
    const c = new BridgeClient("127.0.0.1", 19997);
    r.set("sess-2", c);
    await r.delete("sess-2");
    assert.throws(() => r.get("sess-2"));
  });

  test("list returns all clients", () => {
    const r = new BridgeRegistry();
    const c1 = new BridgeClient("127.0.0.1", 1); const c2 = new BridgeClient("127.0.0.1", 2);
    r.set("a", c1); r.set("b", c2);
    const all = r.list();
    assert.equal(all.length, 2);
    assert.ok(all.includes(c1) && all.includes(c2));
  });
});
```

- [ ] **Step 2: Run tests — verify FAIL**

Run: `npm test`
Expected: FAIL with module-not-found for `src/bridgeRegistry`.

- [ ] **Step 3: Create `src/bridgeRegistry.ts`**

Write the new file:

```ts
/**
 * Per-session BridgeClient registry. Each debugging session owns a single
 * BridgeClient connected to its dedicated x64dbg instance.
 *
 * The registry binds disconnect/reconnect events with the session id in
 * scope so a dead bridge can drive its own session's cleanup.
 */

import { BridgeClient } from "./bridge.js";
import { logger } from "./logger.js";
import { McpError, ErrorCode } from "./errors.js";

export class BridgeRegistry {
  private clients = new Map<string, BridgeClient>();

  set(sessionId: string, client: BridgeClient): void {
    client.on("disconnected", () => {
      logger.error(
        `Bridge for session ${sessionId} disconnected — terminating session`,
      );
      // Lazy import to avoid circular dep with session.ts
      void import("./session.js").then(({ sessions }) => {
        try { void sessions.terminate(sessionId); } catch { /* already gone */ }
      });
    });

    client.on("reconnected", () => {
      logger.info(`Bridge for session ${sessionId} reconnected`);
    });

    this.clients.set(sessionId, client);
  }

  get(sessionId: string): BridgeClient {
    const c = this.clients.get(sessionId);
    if (!c) {
      throw new McpError(
        ErrorCode.E_SESSION_NOT_FOUND,
        `No bridge for session ${sessionId}`,
      );
    }
    return c;
  }

  has(sessionId: string): boolean {
    return this.clients.has(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    const c = this.clients.get(sessionId);
    if (!c) return;
    this.clients.delete(sessionId);
    try { await c.drain(2_000); } catch { /* ignore drain failure */ }
    try { await c.disconnect(); } catch { /* ignore disconnect failure */ }
  }

  list(): BridgeClient[] {
    return Array.from(this.clients.values());
  }
}

/** Process-wide registry. */
export const bridges = new BridgeRegistry();

/** Shorthand for the most common lookup pattern: `bridgeFor(sessionId).call(...)`. */
export function bridgeFor(sessionId: string): BridgeClient {
  return bridges.get(sessionId);
}
```

- [ ] **Step 4: Run tests — verify PASS**

Run: `npm test`
Expected: PASS, all four BridgeRegistry tests + existing tests green.

- [ ] **Step 5: Commit**

```bash
rtk git add src/bridgeRegistry.ts test/basic.test.ts
rtk git commit -m "feat(bridge): add per-session BridgeRegistry and bridgeFor helper"
```

---

## Task 6: Refactor `SessionManager` for multi-session

**Files:**
- Modify: `src/session.ts`
- Modify: `test/basic.test.ts` (SessionManager describe + the "max sessions" test)

- [ ] **Step 1: Update `SessionManager` for `maxSessions`, full cleanup, port-aware create**

Edit `src/session.ts` — replace the entire file:

```ts
/**
 * Session manager — tracks active x64dbg debugging sessions.
 *
 * Each session owns its own x64dbg process and bridge connection. terminate()
 * is the canonical full-cleanup path: disconnect bridge → kill x64dbg → drop
 * session entry. GC reuses the same path when an idle session expires.
 */

import crypto from "crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ErrorCode, McpError } from "./errors.js";
import type { Session, DebugState, Breakpoint, ModuleInfo } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.gcTimer = setInterval(
      () => this.collectExpired(),
      Math.min(config.sessionTimeoutMs / 2, 60_000)
    );
  }

  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      void this.terminate(id);
    }
    this.sessions.clear();
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  create(
    executable: string,
    architecture: "x86" | "x64",
    pid: number,
    bridgePort: number,
  ): Session {
    if (this.sessions.size >= config.maxSessions) {
      const active = this.list().map((s) =>
        `${s.id} (${s.executable}, ${s.state})`,
      ).join(", ");
      throw new McpError(
        ErrorCode.E_SESSION_LIMIT,
        `Reached MAX_SESSIONS=${config.maxSessions}. Active sessions: ${active}. ` +
        `Terminate one before loading another executable.`,
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      pid,
      executable,
      architecture,
      state: "idle",
      bridgePort,
      createdAt: now,
      lastActivity: now,
      breakpoints: new Map(),
      modules: [],
    };

    this.sessions.set(id, session);
    logger.info(
      `Session created: ${id} → ${executable} (${architecture}, port ${bridgePort})`,
    );
    return session;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new McpError(ErrorCode.E_SESSION_NOT_FOUND, `Session not found: ${id}`);
    s.lastActivity = Date.now();
    return s;
  }

  peek(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new McpError(ErrorCode.E_SESSION_NOT_FOUND, `Session not found: ${id}`);
    return s;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  updateState(id: string, state: DebugState): void {
    const s = this.get(id);
    s.state = state;
    s.lastActivity = Date.now();
    logger.debug(`Session ${id} state → ${state}`);
  }

  setModules(id: string, modules: ModuleInfo[]): void {
    const s = this.get(id);
    s.modules = modules;
  }

  addBreakpoint(id: string, bp: Breakpoint): void {
    const s = this.get(id);
    s.breakpoints.set(bp.address, bp);
  }

  removeBreakpoint(id: string, address: string): void {
    const s = this.get(id);
    s.breakpoints.delete(address);
  }

  /**
   * Full cleanup: disconnect bridge, kill the owning x64dbg, drop the session.
   * Safe to call repeatedly; missing pieces are tolerated.
   */
  async terminate(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;

    s.state = "terminated";

    // Lazy import to avoid circular dep
    const [{ bridges }, { killDebuggerForSession }] = await Promise.all([
      import("./bridgeRegistry.js"),
      import("./launcher.js"),
    ]);

    try { await bridges.delete(id); } catch (err) {
      logger.warn(`terminate(${id}): bridge cleanup failed: ${err}`);
    }
    try { killDebuggerForSession(id); } catch (err) {
      logger.warn(`terminate(${id}): debugger kill failed: ${err}`);
    }

    this.sessions.delete(id);
    logger.info(`Session terminated: ${id}`);
  }

  // ── Housekeeping ────────────────────────────────────────────────────────

  private collectExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > config.sessionTimeoutMs) {
        logger.warn(`Session ${id} expired (idle > ${config.sessionTimeoutMs}ms)`);
        void this.terminate(id);
      }
    }
  }

  toJSON(): object[] {
    return this.list().map((s) => ({
      id: s.id,
      pid: s.pid,
      executable: s.executable,
      architecture: s.architecture,
      state: s.state,
      bridgePort: s.bridgePort,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
      breakpoints: Array.from(s.breakpoints.values()),
      moduleCount: s.modules.length,
    }));
  }
}

/** Singleton session manager */
export const sessions = new SessionManager();
```

- [ ] **Step 2: Update SessionManager unit tests**

Edit `test/basic.test.ts`, replace the existing `describe("SessionManager", ...)` block (lines ~200–280) with:

```ts
describe("SessionManager", async () => {
  const { SessionManager } = await importFresh<
    { SessionManager: typeof import("../src/session.js").SessionManager }
  >("src/session.ts");

  test("creates a session with correct fields", () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234, 50000);
    assert.equal(s.executable, "test.exe");
    assert.equal(s.architecture, "x64");
    assert.equal(s.pid, 1234);
    assert.equal(s.bridgePort, 50000);
    assert.equal(s.state, "idle");
    assert.ok(typeof s.id === "string" && s.id.length > 0);
  });

  test("get() returns the session by id", () => {
    const mgr = new SessionManager();
    const s = mgr.create("a.exe", "x86", 1, 50001);
    assert.equal(mgr.get(s.id).id, s.id);
  });

  test("get() throws for unknown id", () => {
    const mgr = new SessionManager();
    assert.throws(() => mgr.get("nonexistent-id"), /Session not found/);
  });

  test("has() returns correct boolean", () => {
    const mgr = new SessionManager();
    const s = mgr.create("b.exe", "x64", 2, 50002);
    assert.equal(mgr.has(s.id), true);
    assert.equal(mgr.has("ghost"), false);
  });

  test("updateState() changes state", () => {
    const mgr = new SessionManager();
    const s = mgr.create("c.exe", "x64", 3, 50003);
    mgr.updateState(s.id, "running");
    assert.equal(mgr.get(s.id).state, "running");
    mgr.updateState(s.id, "paused");
    assert.equal(mgr.get(s.id).state, "paused");
  });

  test("list() returns all sessions", () => {
    const mgr = new SessionManager();
    const s = mgr.create("d.exe", "x64", 4, 50004);
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.list()[0]?.id, s.id);
  });

  test("addBreakpoint() and removeBreakpoint()", () => {
    const mgr = new SessionManager();
    const s = mgr.create("f.exe", "x64", 6, 50005);
    mgr.addBreakpoint(s.id, {
      address: "0x401000",
      type: "software",
      enabled: true,
      hitCount: 0,
    });
    assert.equal(mgr.get(s.id).breakpoints.size, 1);
    mgr.removeBreakpoint(s.id, "0x401000");
    assert.equal(mgr.get(s.id).breakpoints.size, 0);
  });

  test("toJSON() serialises sessions including bridgePort", () => {
    const mgr = new SessionManager();
    mgr.create("g.exe", "x64", 7, 50006);
    const arr = mgr.toJSON() as { executable: string; bridgePort: number }[];
    assert.equal(arr.length, 1);
    assert.equal(arr[0].executable, "g.exe");
    assert.equal(arr[0].bridgePort, 50006);
  });

  test("supports multiple concurrent sessions up to MAX_SESSIONS", () => {
    const mgr = new SessionManager();
    // config.maxSessions defaults to 5; create 5 sessions
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(mgr.create(`exe${i}.exe`, "x64", 100 + i, 51000 + i));
    }
    assert.equal(mgr.list().length, 5);
    // 6th must fail
    assert.throws(
      () => mgr.create("overflow.exe", "x64", 999, 51999),
      /Reached MAX_SESSIONS=5/,
    );
  });
});
```

- [ ] **Step 3: Run tests — verify PASS**

Run: `npm test`
Expected: PASS, including the new "supports multiple concurrent sessions up to MAX_SESSIONS" test.

- [ ] **Step 4: Commit**

```bash
rtk git add src/session.ts test/basic.test.ts
rtk git commit -m "refactor(session): support MAX_SESSIONS, full cleanup in terminate()"
```

---

## Task 7: Add port-aware launchers and per-session ChildProcess map

**Files:**
- Modify: `src/launcher.ts`

- [ ] **Step 1: Replace global `debuggerProcess` with a Map**

Edit `src/launcher.ts`. Replace the `let debuggerProcess: ChildProcess | null = null;` line (around line 25) with:

```ts
/** Per-session ChildProcess tracking for spawned x64dbg/x32dbg instances. */
const debuggerProcesses = new Map<string, ChildProcess>();

/** Legacy single-instance handle (kept for the deprecated singleton path). */
let debuggerProcess: ChildProcess | null = null;
```

- [ ] **Step 2: Add `launchDebuggerOnPort` (the new port-aware spawn)**

Add this function in `src/launcher.ts` after `launchDebugger`:

```ts
/**
 * Multi-session variant: launch x64dbg on a specific bridge port and return
 * both the detected architecture and the ChildProcess handle.
 *
 * Caller is responsible for tracking the ChildProcess (typically by passing
 * it into rememberDebuggerForSession after the session is registered).
 */
export async function launchDebuggerOnPort(
  targetExe: string,
  port: number,
): Promise<{ arch: "x86" | "x64"; child: ChildProcess }> {
  if (!fs.existsSync(targetExe)) {
    throw new Error(`Target executable not found: ${targetExe}`);
  }

  const arch = detectPEArchitecture(targetExe);
  const dbgExe = resolveDebuggerExe(arch);

  logger.info(`Detected ${arch} PE, launching ${path.basename(dbgExe)} on port ${port}`);
  logger.info(`Debugger: ${dbgExe}`);
  logger.info(`Target:   ${targetExe}`);

  const child = spawn(dbgExe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: { ...process.env, BRIDGE_PORT: port.toString() },
  });

  child.on("error", (err: Error) => {
    logger.error(`Debugger process error (port ${port}): ${err.message}`);
  });

  child.on("exit", (code: number | null) => {
    logger.info(`Debugger process exited (port ${port}, code ${code})`);
  });

  child.unref();

  logger.info(`Debugger spawned (pid=${child.pid}, port=${port}), waiting for bridge...`);
  await waitForBridge(config.bridgeHost, port);

  return { arch, child };
}
```

- [ ] **Step 3: Add `launchDebuggerForAttachOnPort`**

Add after the previous function:

```ts
/**
 * Multi-session attach variant: launch x64dbg/x32dbg on a specific bridge port
 * for attaching to a running process by PID. Returns the ChildProcess handle.
 */
export async function launchDebuggerForAttachOnPort(
  pid: number,
  arch: "x86" | "x64",
  port: number,
): Promise<ChildProcess> {
  if (!fs.existsSync(config.x64dbgPath)) {
    throw new Error(`x64dbg installation not found: ${config.x64dbgPath}`);
  }

  const dbgExe = resolveDebuggerExe(arch);

  logger.info(`Launching ${arch} debugger on port ${port} for attaching to PID ${pid}`);

  const child = spawn(dbgExe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: { ...process.env, BRIDGE_PORT: port.toString() },
  });

  child.on("error", (err: Error) => {
    logger.error(`Debugger process error (port ${port}): ${err.message}`);
  });

  child.on("exit", (code: number | null) => {
    logger.info(`Debugger process exited (port ${port}, code ${code})`);
  });

  child.unref();

  logger.info(`Debugger spawned (pid=${child.pid}, port=${port}), waiting for bridge...`);
  await waitForBridge(config.bridgeHost, port);

  return child;
}
```

- [ ] **Step 4: Add per-session tracking and kill helpers**

Add at the end of `src/launcher.ts` (replacing the existing `killDebugger` function):

```ts
/**
 * Track a spawned x64dbg ChildProcess against a sessionId so it can be killed
 * during session teardown. Call after sessions.create() succeeds.
 */
export function rememberDebuggerForSession(sessionId: string, child: ChildProcess): void {
  debuggerProcesses.set(sessionId, child);
}

/**
 * Kill the x64dbg/x32dbg ChildProcess associated with a session, if any.
 * No-op if KEEP_DEBUGGER=1 or the process already exited.
 */
export function killDebuggerForSession(sessionId: string): void {
  if (process.env.KEEP_DEBUGGER === "1") {
    logger.info(`KEEP_DEBUGGER=1 — skipping kill for session ${sessionId}`);
    debuggerProcesses.delete(sessionId);
    return;
  }
  const child = debuggerProcesses.get(sessionId);
  if (!child) return;
  if (child.exitCode === null) {
    logger.info(`Killing debugger for session ${sessionId} (pid=${child.pid})`);
    try { child.kill(); } catch { /* already dead */ }
  }
  debuggerProcesses.delete(sessionId);
}

/**
 * Kill all spawned x64dbg/x32dbg processes (used during MCP server shutdown).
 * Honors KEEP_DEBUGGER=1.
 */
export function killAllDebuggers(): void {
  if (process.env.KEEP_DEBUGGER === "1") {
    logger.info("KEEP_DEBUGGER=1 — skipping all debugger kills");
    debuggerProcesses.clear();
    return;
  }
  for (const [sid, child] of debuggerProcesses) {
    if (child.exitCode === null) {
      logger.info(`Killing debugger for session ${sid} (pid=${child.pid})`);
      try { child.kill(); } catch { /* already dead */ }
    }
  }
  debuggerProcesses.clear();

  // Also kill the legacy singleton handle if still alive (transitional)
  if (debuggerProcess && debuggerProcess.exitCode === null) {
    logger.info("Killing legacy debugger singleton");
    try { debuggerProcess.kill(); } catch { /* already dead */ }
    debuggerProcess = null;
  }
}

/** Legacy single-instance kill — kept until Task 11 removes the last caller. */
export function killDebugger(): void {
  if (process.env.KEEP_DEBUGGER === "1") {
    logger.info("KEEP_DEBUGGER=1 — skipping debugger kill");
    return;
  }
  if (debuggerProcess && debuggerProcess.exitCode === null) {
    logger.info("Killing debugger process");
    debuggerProcess.kill();
    debuggerProcess = null;
  }
}

export function isDebuggerRunning(): boolean {
  return debuggerProcess !== null && debuggerProcess.exitCode === null;
}
```

Remove the old `killDebugger` and `isDebuggerRunning` definitions from earlier in the file (around lines 305–322) so they aren't duplicated.

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: PASS, no errors.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS, all existing tests still green.

- [ ] **Step 7: Commit**

```bash
rtk git add src/launcher.ts
rtk git commit -m "feat(launcher): port-aware spawn + per-session ChildProcess tracking"
```

---

## Task 8: Migrate `src/tools/debug.ts` to per-session bridge

**Files:**
- Modify: `src/tools/debug.ts` (the largest tool file, 22 bridge call sites)

This task does both the mechanical rewiring AND the new orchestration of `load_executable` / `attach_to_process`.

- [ ] **Step 1: Update imports**

Edit `src/tools/debug.ts`. Replace the import block at lines 1–13:

```ts
/**
 * Core debugging tools — load, run, step, stop, breakpoints
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execSync } from "child_process";
import { z } from "zod";
import { BridgeClient } from "../bridge.js";
import { bridges, bridgeFor } from "../bridgeRegistry.js";
import { sessions } from "../session.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import {
  pickFreePort,
  launchDebuggerOnPort,
  launchDebuggerForAttachOnPort,
  killAllDebuggers,
  killDebuggerForSession,
  rememberDebuggerForSession,
  detectProcessArchitecture,
} from "../launcher.js";
import type { Breakpoint, BreakpointType } from "../types.js";
```

- [ ] **Step 2: Refactor `load_executable` orchestration**

Replace the entire `server.tool("load_executable", ...)` block (the body inside the `async ({...}) => {...}` handler). The new handler:

```ts
    async ({ executablePath, commandLineArgs, breakOnEntry, autoAnalyze }) => {
      try {
        executablePath = executablePath
          .trim()
          .replace(/^['"]|['"]$/g, "")
          .trim();

        // 1. Cap check
        if (sessions.list().length >= config.maxSessions) {
          const active = sessions.list().map((s) =>
            `${s.id} (${s.executable}, ${s.state})`,
          ).join(", ");
          return {
            content: [{
              type: "text" as const,
              text: `Error: Reached MAX_SESSIONS=${config.maxSessions}. ` +
                `Active sessions: ${active}. ` +
                `Call terminate_session on one before loading a new executable.`,
            }],
            isError: true,
          };
        }

        // 2. Allocate a free port
        const port = await pickFreePort();
        logger.info(`load_executable: allocated port ${port} for ${executablePath}`);

        // 3. Spawn x64dbg on that port
        let arch: "x86" | "x64";
        let child;
        try {
          ({ arch, child } = await launchDebuggerOnPort(executablePath, port));
        } catch (err) {
          throw new Error(`launchDebuggerOnPort failed: ${err}`);
        }

        // 4. Connect a fresh BridgeClient to the new x64dbg
        const client = new BridgeClient(config.bridgeHost, port);
        try {
          await client.connect();
        } catch (err) {
          try { child.kill(); } catch { /* ignore */ }
          throw new Error(`Bridge connect failed on port ${port}: ${err}`);
        }

        // 5. Tell the bridge to load the executable
        let result: {
          pid: number;
          architecture: "x86" | "x64";
          entryPoint: string;
          modules: { name: string; base: string; size: string; path: string }[];
        };
        try {
          result = await client.call("debug.load", {
            executablePath,
            commandLineArgs: commandLineArgs ?? "",
            breakOnEntry,
            autoAnalyze,
          });
        } catch (err) {
          try { await client.disconnect(); } catch { /* ignore */ }
          try { child.kill(); } catch { /* ignore */ }
          throw err;
        }

        // 6. Register session, bridge, and child process atomically
        const session = sessions.create(
          executablePath,
          result.architecture || arch,
          result.pid,
          port,
        );
        bridges.set(session.id, client);
        rememberDebuggerForSession(session.id, child);

        sessions.updateState(session.id, breakOnEntry ? "paused" : "running");

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              {
                sessionId: session.id,
                pid: result.pid,
                architecture: result.architecture || arch,
                entryPoint: result.entryPoint,
                state: session.state,
                modulesLoaded: result.modules.length,
                bridgePort: port,
              },
              null,
              2,
            ),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`load_executable failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
```

- [ ] **Step 3: Refactor `attach_to_process` orchestration**

Replace the body of `server.tool("attach_to_process", ...)`:

```ts
    async ({ pid, breakOnEntry, autoAnalyze }) => {
      try {
        // 1. Cap check
        if (sessions.list().length >= config.maxSessions) {
          const active = sessions.list().map((s) =>
            `${s.id} (${s.executable}, ${s.state})`,
          ).join(", ");
          return {
            content: [{
              type: "text" as const,
              text: `Error: Reached MAX_SESSIONS=${config.maxSessions}. ` +
                `Active sessions: ${active}. ` +
                `Call terminate_session on one before attaching.`,
            }],
            isError: true,
          };
        }

        // 2. Detect target architecture
        let targetArch: "x86" | "x64";
        try {
          targetArch = detectProcessArchitecture(pid);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: "text" as const,
              text: `Error: Could not determine process architecture for PID ${pid}. ${msg}.`,
            }],
            isError: true,
          };
        }

        // 3. Allocate port + spawn debugger
        const port = await pickFreePort();
        logger.info(`attach_to_process: allocated port ${port} for PID ${pid}`);
        const child = await launchDebuggerForAttachOnPort(pid, targetArch, port);

        // 4. Connect bridge
        const client = new BridgeClient(config.bridgeHost, port);
        try {
          await client.connect();
        } catch (err) {
          try { child.kill(); } catch { /* ignore */ }
          throw err;
        }

        // 5. Tell bridge to attach
        const session = sessions.create(`<attached-pid-${pid}>`, targetArch, pid, port);
        bridges.set(session.id, client);
        rememberDebuggerForSession(session.id, child);

        try {
          const result = await client.call<{
            pid: number;
            architecture: string;
            entryPoint: string;
            modules: Array<{ name: string; base: string; size: number }>;
          }>("debug.attach", {
            sessionId: session.id,
            pid,
            breakOnEntry,
            autoAnalyze,
          }, 90_000);

          sessions.updateState(session.id, "paused");

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                sessionId: session.id,
                pid: result.pid,
                architecture: result.architecture,
                entryPoint: result.entryPoint,
                state: "paused",
                modulesLoaded: 0,
                bridgePort: port,
              }, null, 2),
            }],
          };
        } catch (err) {
          await sessions.terminate(session.id);
          throw err;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`attach_to_process failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
```

- [ ] **Step 4: Migrate every other tool's `bridge.call(...)` → `bridgeFor(sessionId).call(...)`**

In `src/tools/debug.ts`, find every remaining `bridge.call(` and `bridge.isConnected` reference and rewrite. Specifically:

- `continue_execution`: change `bridge.call(...)` → `bridgeFor(sessionId).call(...)`
- `pause_execution`: same
- `step_into`, `step_over`, `step_out`, `run_to_address`: same
- `set_breakpoint`, `remove_breakpoint`, `list_breakpoints`: same
- `terminate_session`: replace the `if (bridge.isConnected) { ... bridge.call("debug.stop") ... }` block with:

```ts
        try {
          const b = bridges.has(sessionId) ? bridgeFor(sessionId) : null;
          if (b && b.isConnected) {
            try { await b.call("debug.stop", { sessionId }); } catch (err) {
              logger.warn(`debug.stop failed (continuing cleanup): ${err}`);
            }
          }
        } catch { /* no bridge to stop */ }
        await sessions.terminate(sessionId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              { status: "terminated", sessionId, debuggerKept: false },
              null, 2,
            ),
          }],
        };
```

(Note: `debuggerKept` flips to `false` because terminate_session now also kills x64dbg.)

- `detach_session`: replace the `if (!bridge.isConnected)` guard with:

```ts
        let b: BridgeClient;
        try { b = bridgeFor(sessionId); } catch {
          return {
            content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
            isError: true,
          };
        }
        if (!b.isConnected) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Bridge is not connected, cannot detach the live debuggee safely.",
            }],
            isError: true,
          };
        }

        await b.call("debug.detach", { sessionId });
        await sessions.terminate(sessionId);
```

- `get_status`: rewrite top-level status fields:

```ts
      const status: Record<string, unknown> = {
        activeSessions: sessions.list().length,
        maxSessions: config.maxSessions,
      };

      if (sessionId) {
        const s = sessions.list().find((x) => x.id === sessionId);
        if (!s) {
          status.session = { error: `Session not found: ${sessionId}` };
        } else {
          let bridgeConnected = false;
          let b: BridgeClient | null = null;
          try { b = bridgeFor(sessionId); bridgeConnected = b.isConnected; } catch { /* mid-teardown */ }

          status.session = {
            id: s.id,
            state: s.state,
            executable: s.executable,
            architecture: s.architecture,
            pid: s.pid,
            bridgePort: s.bridgePort,
            bridgeConnected,
            breakpointCount: s.breakpoints.size,
          };

          if (b && b.isConnected && (s.state === "paused" || s.state === "idle")) {
            try {
              const regs = await b.call<{ general: Record<string, string> }>(
                "registers.get",
                { sessionId, includeSegment: false, includeDebug: false, includeFpu: false }
              );
              const cip = regs.general["rip"] ?? regs.general["eip"] ?? "unknown";
              status.currentIP = cip;
            } catch {
              // Non-fatal
            }
          }

          const hint =
            s.state === "paused"
              ? "Debuggee is paused. You may call: step_into, step_over, step_out, continue_execution, get_registers, disassemble, read_memory."
              : s.state === "running"
              ? "Debuggee is running. Wait for it to pause at a breakpoint, or call terminate_session."
              : s.state === "idle"
              ? "Session created but no execution started yet. Call continue_execution to run."
              : s.state === "terminated"
              ? "Session terminated. Call load_executable to start a new session."
              : `Session is in state '${s.state}'.`;
          status.hint = hint;
        }
      } else {
        const all = sessions.toJSON();
        if (all.length > 0) {
          status.sessions = all;
          status.hint = "Pass a sessionId to get detailed status for a specific session.";
        } else {
          status.hint = "No active sessions. Call load_executable with an absolute path to a PE (.exe/.dll) to start debugging.";
        }
      }
```

- `close_debugger`: replace the body with:

```ts
    async ({ force }) => {
      const lines: string[] = [];
      const ids = sessions.list().map((s) => s.id);
      for (const id of ids) {
        try { await sessions.terminate(id); } catch (err) {
          lines.push(`terminate(${id}) failed: ${err}`);
        }
      }
      lines.push(`Terminated ${ids.length} session(s) and disconnected each bridge.`);

      killAllDebuggers();
      lines.push("Killed all tracked debugger processes.");

      if (force) {
        try {
          execSync("taskkill /IM x64dbg.exe /F", { stdio: "pipe" });
          lines.push("Force-killed x64dbg.exe via taskkill.");
        } catch {
          lines.push("x64dbg.exe not running (taskkill found nothing).");
        }
        try {
          execSync("taskkill /IM x32dbg.exe /F", { stdio: "pipe" });
          lines.push("Force-killed x32dbg.exe via taskkill.");
        } catch {
          lines.push("x32dbg.exe not running (taskkill found nothing).");
        }
      }

      logger.info("close_debugger: " + lines.join(" "));
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
```

- `collect_bp_args`, `execute_command`: change `bridge.call(...)` → `bridgeFor(sessionId).call(...)`

- [ ] **Step 5: Build to verify no compile errors**

Run: `npm run build`
Expected: PASS. (Other tool files still use the singleton `bridge`; that's still exported, so this works.)

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS — no test currently invokes load_executable end-to-end, so the orchestration path doesn't break tests. Static checks must all pass.

- [ ] **Step 7: Commit**

```bash
rtk git add src/tools/debug.ts
rtk git commit -m "refactor(tools/debug): migrate to per-session bridge + multi-session orchestration"
```

---

## Task 9: Migrate `src/tools/memory.ts`, `analysis.ts`, `security.ts`

**Files:**
- Modify: `src/tools/memory.ts`, `src/tools/analysis.ts`, `src/tools/security.ts`

This is mechanical: each file does only `bridge.call(...)` for its operations.

- [ ] **Step 1: Migrate `memory.ts`**

In `src/tools/memory.ts`:

1. Change the import at the top: replace `import { bridge } from "../bridge.js";` with:

```ts
import { bridgeFor } from "../bridgeRegistry.js";
```

2. Find every `bridge.call(` in the file and change it to `bridgeFor(sessionId).call(`. There are 9 call sites; each tool handler already destructures `sessionId` from its arguments.

- [ ] **Step 2: Migrate `analysis.ts` (10 call sites)**

Apply the same transformation to `src/tools/analysis.ts`.

- [ ] **Step 3: Migrate `security.ts` (8 call sites)**

Apply the same transformation to `src/tools/security.ts`.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS, no compile errors.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS (no test exercises these tools end-to-end at unit level).

- [ ] **Step 6: Commit**

```bash
rtk git add src/tools/memory.ts src/tools/analysis.ts src/tools/security.ts
rtk git commit -m "refactor(tools): migrate memory/analysis/security to bridgeFor"
```

---

## Task 10: Update `src/server.ts` lifecycle

**Files:**
- Modify: `src/server.ts:62-171`

- [ ] **Step 1: Drop `bridge.connect()` at startup; switch to per-session shutdown**

Replace the dynamic-imports block and `main()`/`shutdown()` body in `src/server.ts`. New version:

```ts
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { sessions } = await import("./session.js");
const { bridges } = await import("./bridgeRegistry.js");
const { logger } = await import("./logger.js");
const { config } = await import("./config.js");
const { createMcpServer } = await import("./mcpServer.js");
const { startHttpMcpServer } = await import("./httpServer.js");
const { killAllDebuggers } = await import("./launcher.js");

const runtimeTransport = cliOverrides.transport ?? config.mcpTransport;
const runtimeHttpHost = cliOverrides.host ?? config.mcpHttpHost;
const runtimeHttpPort = cliOverrides.port ?? config.mcpHttpPort;
const runtimeHttpPath = "/mcp";

async function main(): Promise<void> {
  logger.info("x64dbg MCP Server starting …");
  logger.info(`x64dbg path : ${config.x64dbgPath}`);
  logger.info(`MCP transport: ${runtimeTransport}`);
  logger.info(`Max sessions: ${config.maxSessions}`);

  // No global bridge connect: each session creates its own bridge on demand.
  sessions.start();

  let closeTransport = async (): Promise<void> => {};

  if (runtimeTransport === "streamable-http") {
    const httpServer = await startHttpMcpServer({
      host: runtimeHttpHost,
      port: runtimeHttpPort,
      path: runtimeHttpPath,
      createServer: createMcpServer,
    });
    closeTransport = httpServer.close;
    logger.info(
      `x64dbg MCP Server is ready (Streamable HTTP transport at http://${httpServer.host}:${httpServer.port}${httpServer.path})`,
    );
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    closeTransport = async () => { await server.close(); };
    logger.info("x64dbg MCP Server is ready (STDIO transport)");
  }

  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down …");
    await closeTransport();

    // Drain and tear down each session in parallel.
    await Promise.all(sessions.list().map(async (s) => {
      try {
        if (bridges.has(s.id)) {
          await bridges.get(s.id).drain(2_000);
        }
      } catch { /* ignore drain errors */ }
      try { await sessions.terminate(s.id); } catch { /* ignore */ }
    }));

    sessions.stop();
    killAllDebuggers();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (runtimeTransport === "stdio") {
    process.stdin.on("close", shutdown);
  }
}
```

(Note: also remove the import of `bridge` and `killDebugger` from server.ts. Add `bridges.has` to BridgeRegistry — already done in Task 5.)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
rtk git add src/server.ts
rtk git commit -m "refactor(server): drop global bridge, parallel per-session shutdown"
```

---

## Task 11: Drop the singleton `bridge` export

**Files:**
- Modify: `src/bridge.ts` (remove last 5 lines)

- [ ] **Step 1: Remove the deprecated singleton**

Edit `src/bridge.ts`. Delete the trailing block:

```ts
/** Singleton bridge instance (deprecated — kept for transitional compat; will be removed in Task 11). */
export const bridge = new BridgeClient();
```

Replace with:

```ts
// Singleton removed — every BridgeClient is owned by a session via bridgeRegistry.
```

- [ ] **Step 2: Build to confirm no caller still imports it**

Run: `npm run build`
Expected: PASS. If any file errors with "Module has no exported member 'bridge'", fix that import to use `bridgeFor` from `bridgeRegistry`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
rtk git add src/bridge.ts
rtk git commit -m "refactor(bridge): remove deprecated singleton export"
```

---

## Task 12: Document `MAX_SESSIONS` in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append docs entry**

Edit `.env.example`. Add (placement: near `SESSION_TIMEOUT_MS` if it exists, otherwise before any limits section):

```
# Maximum concurrent debug sessions (each spawns its own x64dbg).
# Default: 5
# MAX_SESSIONS=5
```

- [ ] **Step 2: Commit**

```bash
rtk git add .env.example
rtk git commit -m "docs(env): document MAX_SESSIONS"
```

---

## Task 13: HTTP fixture sources and CMakeLists

**Files:**
- Create: `test/fixtures/http_server.c`
- Create: `test/fixtures/http_client.c`
- Create: `test/fixtures/CMakeLists.txt`
- Create: `test/fixtures/.gitignore`

- [ ] **Step 1: Write the server fixture**

Create `test/fixtures/http_server.c`:

```c
/* http_server.c — minimal Winsock TCP echo server for integration test.
 * Listens on 127.0.0.1:18080, accepts ONE connection, echoes "PONG\r\n", exits. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>

#pragma comment(lib, "ws2_32.lib")

int main(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == INVALID_SOCKET) { WSACleanup(); return 2; }

    BOOL yes = TRUE;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(18080);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (bind(srv, (struct sockaddr*)&addr, sizeof(addr)) != 0) { closesocket(srv); WSACleanup(); return 3; }
    if (listen(srv, 1) != 0) { closesocket(srv); WSACleanup(); return 4; }

    SOCKET cli = accept(srv, NULL, NULL);
    if (cli == INVALID_SOCKET) { closesocket(srv); WSACleanup(); return 5; }

    char buf[256];
    int n = recv(cli, buf, sizeof(buf) - 1, 0);
    if (n <= 0) { closesocket(cli); closesocket(srv); WSACleanup(); return 6; }

    const char* reply = "PONG\r\n";
    send(cli, reply, (int)strlen(reply), 0);

    closesocket(cli);
    closesocket(srv);
    WSACleanup();
    return 0;
}
```

- [ ] **Step 2: Write the client fixture**

Create `test/fixtures/http_client.c`:

```c
/* http_client.c — minimal Winsock TCP client.
 * Connects to 127.0.0.1:18080, sends "PING\r\n", reads response, exits 0 on PONG. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "ws2_32.lib")

int main(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { WSACleanup(); return 2; }

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(18080);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        closesocket(sock); WSACleanup(); return 3;
    }

    const char* msg = "PING\r\n";
    if (send(sock, msg, (int)strlen(msg), 0) <= 0) { closesocket(sock); WSACleanup(); return 4; }

    char buf[256];
    int n = recv(sock, buf, sizeof(buf) - 1, 0);
    if (n <= 0) { closesocket(sock); WSACleanup(); return 5; }
    buf[n] = 0;

    closesocket(sock);
    WSACleanup();
    return strstr(buf, "PONG") ? 0 : 6;
}
```

- [ ] **Step 3: Write CMakeLists**

Create `test/fixtures/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.15)
project(x64dbg_mcp_fixtures C)

set(CMAKE_C_STANDARD 99)

add_executable(http_server http_server.c)
target_link_libraries(http_server PRIVATE ws2_32)

add_executable(http_client http_client.c)
target_link_libraries(http_client PRIVATE ws2_32)
```

- [ ] **Step 4: Add .gitignore for build artifacts**

Create `test/fixtures/.gitignore`:

```
build/
```

- [ ] **Step 5: Build the fixtures locally to verify they compile**

Run: `cmake -S test/fixtures -B test/fixtures/build -A x64`
Expected: PASS.

Run: `cmake --build test/fixtures/build --config Release`
Expected: PASS, produces `test/fixtures/build/Release/http_server.exe` and `http_client.exe`.

- [ ] **Step 6: Smoke-test the fixtures (optional but recommended)**

Open two terminals and run server then client:

Terminal 1: `./test/fixtures/build/Release/http_server.exe` (blocks on accept)
Terminal 2: `./test/fixtures/build/Release/http_client.exe` && echo "exit $?"
Expected: client prints `exit 0`, server exits.

- [ ] **Step 7: Commit**

```bash
rtk git add test/fixtures/http_server.c test/fixtures/http_client.c test/fixtures/CMakeLists.txt test/fixtures/.gitignore
rtk git commit -m "test(fixtures): add Winsock HTTP server/client fixtures for multi-session test"
```

---

## Task 14: npm scripts for fixture build and integration test

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add scripts**

Edit `package.json`. Inside `"scripts"`, add:

```json
    "build:fixtures": "cmake -S test/fixtures -B test/fixtures/build -A x64 && cmake --build test/fixtures/build --config Release",
    "test:integration": "npx tsx --test test/integration/multi-session.test.ts"
```

- [ ] **Step 2: Sanity-check `build:fixtures` runs**

Run: `npm run build:fixtures`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
rtk git add package.json
rtk git commit -m "test(scripts): add build:fixtures and test:integration"
```

---

## Task 15: Multi-session integration test

**Files:**
- Create: `test/integration/multi-session.test.ts`

This test requires a real x64dbg installation and built fixtures. It is gated by both checks and skipped gracefully when prerequisites are missing.

- [ ] **Step 1: Write the integration test**

Create `test/integration/multi-session.test.ts`:

```ts
/**
 * Multi-session integration test.
 *
 * Runs ONLY when:
 *   - x64dbg binaries are present at the expected default location
 *   - Fixtures have been built (run `npm run build:fixtures`)
 *
 * What it verifies:
 *   - Two concurrent load_executable calls each get a distinct bridgePort
 *   - Breakpoints set on each session do not leak across sessions
 *   - Continue/breakpoint hits are observed independently
 *   - terminate_session of one session leaves the other functional
 *   - On full teardown, both x64dbg processes are killed
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const SERVER_EXE = path.join(ROOT, "test", "fixtures", "build", "Release", "http_server.exe");
const CLIENT_EXE = path.join(ROOT, "test", "fixtures", "build", "Release", "http_client.exe");
const X64DBG_EXE = path.join(ROOT, "x64dbg", "release", "x64", "x64dbg.exe");

const PREREQS_MET =
  fs.existsSync(SERVER_EXE) && fs.existsSync(CLIENT_EXE) && fs.existsSync(X64DBG_EXE);

async function importFresh<T>(relPath: string): Promise<T> {
  const abs = path.join(ROOT, relPath).replace(/\\/g, "/");
  return import(`file:///${abs}`) as Promise<T>;
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => { srv.close(); resolve(false); });
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

describe("multi-session integration", { skip: !PREREQS_MET && "fixtures or x64dbg missing — run `npm run build:fixtures`" }, async () => {
  // Direct in-process invocation of MCP tool handlers via the registered
  // McpServer. We bypass the wire protocol to keep the test focused.
  const { createMcpServer } = await importFresh<typeof import("../../src/mcpServer.js")>("src/mcpServer.ts");
  const { sessions } = await importFresh<typeof import("../../src/session.js")>("src/session.ts");
  const { bridges } = await importFresh<typeof import("../../src/bridgeRegistry.js")>("src/bridgeRegistry.ts");

  // Helper: invoke a registered tool by name
  async function callTool(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    // McpServer stores handlers internally; use the public request interface.
    const handlers = (server as unknown as { _registeredTools: Record<string, { callback: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> })._registeredTools;
    const tool = handlers[name];
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const res = await tool.callback(args);
    return { text: res.content[0]?.text ?? "", isError: res.isError };
  }

  let server: ReturnType<typeof createMcpServer>;
  before(() => { server = createMcpServer(); });

  after(async () => {
    // Defensive teardown: terminate any sessions left over.
    for (const s of [...sessions.list()]) {
      try { await sessions.terminate(s.id); } catch { /* ignore */ }
    }
  });

  test("two concurrent sessions with distinct bridge ports", async (t) => {
    const a = JSON.parse((await callTool(server, "load_executable", {
      executablePath: SERVER_EXE,
      breakOnEntry: true,
      autoAnalyze: false,
    })).text);
    const b = JSON.parse((await callTool(server, "load_executable", {
      executablePath: CLIENT_EXE,
      breakOnEntry: true,
      autoAnalyze: false,
    })).text);

    t.diagnostic(`server session: ${a.sessionId} (port ${a.bridgePort})`);
    t.diagnostic(`client session: ${b.sessionId} (port ${b.bridgePort})`);

    assert.equal(sessions.list().length, 2);
    assert.notEqual(a.bridgePort, b.bridgePort);
    assert.ok(a.bridgePort >= 49152 && a.bridgePort <= 65535);
    assert.ok(b.bridgePort >= 49152 && b.bridgePort <= 65535);

    // Set BPs on each session. Server breaks at ws2_32.accept; client at ws2_32.connect.
    const bpA = JSON.parse((await callTool(server, "set_breakpoint", {
      sessionId: a.sessionId,
      address: "ws2_32.accept",
      type: "software",
    })).text);
    assert.equal(bpA.status, "breakpoint_set");

    const bpB = JSON.parse((await callTool(server, "set_breakpoint", {
      sessionId: b.sessionId,
      address: "ws2_32.connect",
      type: "software",
    })).text);
    assert.equal(bpB.status, "breakpoint_set");

    // Resume server first (must enter listen + accept before the client connects).
    const contA = callTool(server, "continue_execution", { sessionId: a.sessionId });
    // Small delay to let the server reach accept().
    await new Promise((r) => setTimeout(r, 1500));
    const contB = callTool(server, "continue_execution", { sessionId: b.sessionId });

    const [resA, resB] = await Promise.all([contA, contB]);
    const stopA = JSON.parse(resA.text);
    const stopB = JSON.parse(resB.text);
    t.diagnostic(`server stop: ${JSON.stringify(stopA)}`);
    t.diagnostic(`client stop: ${JSON.stringify(stopB)}`);

    // Both should have stopped at their respective breakpoints.
    assert.equal(stopA.stopReason, "breakpoint");
    assert.equal(stopB.stopReason, "breakpoint");

    // Verify breakpoints did NOT leak across sessions.
    const bpsA = JSON.parse((await callTool(server, "list_breakpoints", { sessionId: a.sessionId })).text);
    const bpsB = JSON.parse((await callTool(server, "list_breakpoints", { sessionId: b.sessionId })).text);
    const addrsA = bpsA.breakpoints.map((bp: { address: string }) => bp.address.toLowerCase());
    const addrsB = bpsB.breakpoints.map((bp: { address: string }) => bp.address.toLowerCase());
    assert.ok(addrsA.some((a: string) => a.includes("accept")), `expected accept BP in session A: ${JSON.stringify(addrsA)}`);
    assert.ok(addrsB.some((a: string) => a.includes("connect")), `expected connect BP in session B: ${JSON.stringify(addrsB)}`);
    assert.ok(!addrsA.some((a: string) => a.includes("connect")), "session A must not have connect BP");
    assert.ok(!addrsB.some((a: string) => a.includes("accept")), "session B must not have accept BP");

    // Continue both to let the PING/PONG exchange complete.
    await callTool(server, "continue_execution", { sessionId: a.sessionId });
    await callTool(server, "continue_execution", { sessionId: b.sessionId });

    // Wait briefly for fixtures to exit.
    await new Promise((r) => setTimeout(r, 2000));

    // Terminate session A; verify session B is unaffected.
    const portA = a.bridgePort;
    await callTool(server, "terminate_session", { sessionId: a.sessionId });
    assert.equal(sessions.has(a.sessionId), false);
    assert.equal(bridges.has(a.sessionId), false);

    // Session B status should still be queryable.
    const statusB = JSON.parse((await callTool(server, "get_status", { sessionId: b.sessionId })).text);
    assert.ok(statusB.session, "session B status should still be available");

    // Terminate session B.
    await callTool(server, "terminate_session", { sessionId: b.sessionId });
    assert.equal(sessions.list().length, 0);

    // Allow OS time to release ports
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await isPortFree(portA), true, `port ${portA} should be released`);
  });
});
```

- [ ] **Step 2: Verify the test runs (skipped path) without fixtures**

Temporarily rename the fixtures dir if it has been built, then run:
```bash
npm run test:integration
```
Expected: SKIPPED with message "fixtures or x64dbg missing — run `npm run build:fixtures`".

(Restore the fixtures dir.)

- [ ] **Step 3: Verify the test runs (full path) with fixtures + x64dbg**

Run: `npm run build:fixtures && npm run test:integration`
Expected: PASS, all assertions green. (Test takes ~10–15 s while x64dbg starts/stops.)

If a test fails, capture the `t.diagnostic` output for inspection — typical failures: x64dbg not found at default path (set `X64DBG_PATH` env), Windows Defender holding the loader DLL, BP symbol lookup failing (need the bridge plugin built and installed).

- [ ] **Step 4: Commit**

```bash
rtk git add test/integration/multi-session.test.ts
rtk git commit -m "test: add multi-session integration test (HTTP server + client)"
```

---

## Self-Review

Spec coverage check:

| Spec section | Implemented in |
|--------------|----------------|
| §1 Architecture overview | T1, T7, T8, T10 |
| §2 Data structures (Session.bridgePort, ServerConfig.maxSessions, BridgeClient ctor, BridgeRegistry, launcher API, SessionManager.create / terminate) | T1, T4, T5, T6, T7 |
| §3 Tool layer mechanical migration | T8, T9 |
| §4 Server lifecycle (no startup connect, parallel shutdown, per-session bridge events) | T5 (event binding), T10 |
| §5 Error handling (rollback in load_executable, MAX_SESSIONS check, port exhaustion, per-session disconnect) | T2 (E_PORT_EXHAUSTED), T6 (cap check), T8 (rollback flow), T5 (event binding) |
| §6 Integration test (fixtures + scripts + test) | T13, T14, T15 |
| §7 Out of scope | n/a |

Placeholder scan: no "TBD" / "TODO" / "implement later" terms; every code step contains complete code.

Type consistency: `pickFreePort()`, `launchDebuggerOnPort()`, `launchDebuggerForAttachOnPort()`, `rememberDebuggerForSession()`, `killDebuggerForSession()`, `killAllDebuggers()`, `BridgeClient(host, port)`, `BridgeRegistry.{set,get,has,delete,list}`, `bridgeFor()`, `bridges`, `sessions.create(exe, arch, pid, port)`, `Session.bridgePort`, `ServerConfig.maxSessions`, `ErrorCode.E_PORT_EXHAUSTED` — names are uniform across all tasks.
