/**
 * Basic automated tests — no x64dbg required.
 * Run with:  npx tsx test/basic.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// CI runners do not bundle x64dbg binaries; tests that require them are
// skipped automatically when the binaries are not present on disk.
const HAS_X64DBG_BINARIES = fs.existsSync(
  path.join(ROOT, "x64dbg", "release", "x64", "x64dbg.exe"),
);

// ─── helpers ────────────────────────────────────────────────────────────────

async function importFresh<T>(relPath: string): Promise<T> {
  const abs = path.join(ROOT, relPath).replace(/\\/g, "/");
  return import(`file:///${abs}`) as Promise<T>;
}

// ─── PE architecture detection ───────────────────────────────────────────────

describe("detectPEArchitecture", async () => {
  const { detectPEArchitecture } = await importFresh<
    typeof import("../src/launcher.js")
  >("src/launcher.ts");

  test("detects x64 PE (notepad)", () => {
    const notepad64 = "C:\\Windows\\System32\\notepad.exe";
    const arch = detectPEArchitecture(notepad64);
    assert.equal(arch, "x64");
  });

  test("detects x86 PE (SysWOW64 notepad)", () => {
    const notepad32 = "C:\\Windows\\SysWOW64\\notepad.exe";
    try {
      const arch = detectPEArchitecture(notepad32);
      assert.equal(arch, "x86");
    } catch {
      // SysWOW64 may not exist on some Windows editions — skip gracefully
      console.log("  (SysWOW64\\notepad.exe not found, skipping)");
    }
  });

  test("throws on non-PE file", () => {
    const nonPE = "C:\\Windows\\System32\\drivers\\etc\\hosts";
    assert.throws(() => detectPEArchitecture(nonPE), /Not a valid PE file/);
  });

  test("throws on missing file", () => {
    assert.throws(
      () => detectPEArchitecture("C:\\nonexistent_x64dbg_test.exe"),
      /ENOENT|no such file/i
    );
  });

  test(
    "detects loaddll.exe (x64dbg test host x64)",
    { skip: !HAS_X64DBG_BINARIES && "x64dbg binaries not present" },
    () => {
      const loaddll = path.join(ROOT, "x64dbg", "release", "x64", "loaddll.exe");
      const arch = detectPEArchitecture(loaddll);
      assert.equal(arch, "x64");
    },
  );

  test(
    "detects loaddll.exe (x64dbg test host x32)",
    { skip: !HAS_X64DBG_BINARIES && "x64dbg binaries not present" },
    () => {
      const loaddll = path.join(ROOT, "x64dbg", "release", "x32", "loaddll.exe");
      const arch = detectPEArchitecture(loaddll);
      assert.equal(arch, "x86");
    },
  );
});

// ─── Debugger path resolution ────────────────────────────────────────────────

describe("resolveDebuggerExe", async () => {
  const { resolveDebuggerExe } = await importFresh<
    typeof import("../src/launcher.js")
  >("src/launcher.ts");

  test(
    "resolves x64dbg.exe for x64",
    { skip: !HAS_X64DBG_BINARIES && "x64dbg binaries not present" },
    () => {
      const exe = resolveDebuggerExe("x64");
      assert.ok(exe.endsWith("x64dbg.exe"), `Expected x64dbg.exe, got: ${exe}`);
    },
  );

  test(
    "resolves x32dbg.exe for x86",
    { skip: !HAS_X64DBG_BINARIES && "x64dbg binaries not present" },
    () => {
      const exe = resolveDebuggerExe("x86");
      assert.ok(exe.endsWith("x32dbg.exe"), `Expected x32dbg.exe, got: ${exe}`);
    },
  );
});

// ─── pickFreePort ─────────────────────────────────────────────────────────────

describe("pickFreePort", async () => {
  const { pickFreePort } = await importFresh<
    typeof import("../src/launcher.js")
  >("src/launcher.ts");

  test("returns a port in the registered range", async () => {
    const p = await pickFreePort();
    assert.ok(p >= 30000 && p <= 44999, `port out of range: ${p}`);
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

// ─── cmdLineArgs splitting ────────────────────────────────────────────────────

describe("cmdLineArgs splitting (regression)", () => {
  // Test the splitting logic extracted from launcher.ts
  function splitArgs(cmdLineArgs: string): string[] {
    const tokens = cmdLineArgs.match(/"[^"]*"|'[^']*'|\S+/g);
    if (!tokens) return [];
    return tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  }

  test("splits simple args", () => {
    assert.deepEqual(splitArgs("--foo bar"), ["--foo", "bar"]);
  });

  test("preserves quoted path with spaces", () => {
    assert.deepEqual(splitArgs('"C:\\Program Files\\test.exe" --flag'), [
      "C:\\Program Files\\test.exe",
      "--flag",
    ]);
  });

  test("handles single-quoted tokens", () => {
    assert.deepEqual(splitArgs("'hello world' --x"), ["hello world", "--x"]);
  });

  test("empty string gives no args", () => {
    assert.deepEqual(splitArgs(""), []);
  });
});

// ─── CLI runtime overrides ──────────────────────────────────────────────────

describe("parseCliRuntimeOverrides", async () => {
  const { parseCliRuntimeOverrides, renderCliUsage } = await importFresh<
    typeof import("../src/cli.js")
  >("src/cli.ts");

  test("parses streamable HTTP startup flags", () => {
    const options = parseCliRuntimeOverrides([
      "--transport",
      "streamable-http",
      "--host",
      "localhost",
      "--port",
      "3602",
    ]);

    assert.deepEqual(options, {
      transport: "streamable-http",
      host: "localhost",
      port: 3602,
      showHelp: false,
    });
  });

  test("accepts --transport=http alias", () => {
    const options = parseCliRuntimeOverrides(["--transport=http"]);
    assert.equal(options.transport, "streamable-http");
    assert.equal(options.showHelp, false);
  });

  test("recognises help flag", () => {
    const options = parseCliRuntimeOverrides(["--help"]);
    assert.equal(options.showHelp, true);
  });

  test("rejects legacy sse transport mode", () => {
    assert.throws(
      () => parseCliRuntimeOverrides(["--transport", "sse"]),
      /Unsupported transport/
    );
  });

  test("rejects unknown arguments", () => {
    assert.throws(
      () => parseCliRuntimeOverrides(["--path", "/custom"]),
      /Unknown argument/
    );
  });

  test("usage mentions fixed HTTP path", () => {
    assert.match(renderCliUsage(), /fixed at \/mcp/);
  });
});

// ─── SessionManager ───────────────────────────────────────────────────────────

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
    // D2: sessions are created post-`debug.load` at the entry-point pause.
    assert.equal(s.state, "paused");
    assert.equal(s.pauseReason, "system_breakpoint");
    assert.equal(s.terminationReason, null);
    assert.deepEqual(s.recentEvents, []);
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

  test("supports multiple concurrent sessions up to MAX_SESSIONS", async () => {
    // Temporarily patch the shared config singleton to maxSessions=5 so this
    // test is independent of the local .env value (which may be 1 in dev).
    const cfgMod = await importFresh<typeof import("../src/config.js")>("src/config.ts");
    const origMax = cfgMod.config.maxSessions;
    (cfgMod.config as Record<string, unknown>).maxSessions = 5;
    try {
      const mgr = new SessionManager();
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
    } finally {
      (cfgMod.config as Record<string, unknown>).maxSessions = origMax;
    }
  });
});

// ─── T9: terminated session 30s retention ────────────────────────────────────

describe("T9: terminated session 30s retention", async () => {
  const { SessionManager } = await importFresh<
    { SessionManager: typeof import("../src/session.js").SessionManager }
  >("src/session.ts");

  test("T9: terminated session readable at 29s, reaped at 31s (fast clock)", async () => {
    const mgr = new SessionManager();
    let fakeNow = 1_000_000;
    (mgr as Record<string, unknown>)["_now"] = () => fakeNow;

    const s = mgr.create("test.exe", "x64", 1, 53000);
    await mgr.terminate(s.id);

    assert.ok(mgr.has(s.id), "session must stay in map after terminate()");
    assert.equal(mgr.peek(s.id).state, "terminated");

    fakeNow += 29_000;
    (mgr as Record<string, unknown>)["collectExpired"]?.();
    assert.ok(mgr.has(s.id), "session still present at t+29s");

    fakeNow += 2_000;
    (mgr as Record<string, unknown>)["collectExpired"]?.();
    assert.ok(!mgr.has(s.id), "session reaped at t+31s");
  });

  test("T9: reads during window do not extend retention", async () => {
    const mgr = new SessionManager();
    let fakeNow = 2_000_000;
    (mgr as Record<string, unknown>)["_now"] = () => fakeNow;

    const s = mgr.create("test.exe", "x64", 1, 53001);
    await mgr.terminate(s.id);
    const terminatedAt = mgr.peek(s.id).terminatedAt!;
    assert.ok(terminatedAt > 0, "terminatedAt must be set");

    // reads at 10s, 20s, 29s
    fakeNow = terminatedAt + 10_000;
    mgr.peek(s.id);
    fakeNow = terminatedAt + 20_000;
    mgr.peek(s.id);
    fakeNow = terminatedAt + 29_000;
    mgr.peek(s.id);

    // at 31s, must be reaped regardless of reads
    fakeNow = terminatedAt + 31_000;
    (mgr as Record<string, unknown>)["collectExpired"]?.();
    assert.ok(!mgr.has(s.id), "reads must not extend the 30s retention window");
  });

  test("T9: peek() returns terminated session during window without throwing", async () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1, 53002);
    await mgr.terminate(s.id);

    const retrieved = mgr.peek(s.id);
    assert.equal(retrieved.state, "terminated");
    assert.equal(retrieved.id, s.id);
  });
});

// ─── T8: SessionManager state model + state-change CV ────────────────────────

import { EventEmitter } from "node:events";

describe("T8: SessionManager state model + state-change CV", async () => {
  const { SessionManager } = await importFresh<
    { SessionManager: typeof import("../src/session.js").SessionManager }
  >("src/session.ts");

  test("T8: wireClient debugEvent updates lastEvent + recentEvents", async () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234, 52000);
    const fakeClient = new EventEmitter();
    mgr.wireClient(s.id, fakeClient);

    const ev = {
      kind: "breakpoint" as const,
      address: "0x401000",
      threadId: 1,
      pausedExecution: true,
      timestamp: Date.now(),
      details: {},
    };
    fakeClient.emit("debugEvent", ev);

    const updated = mgr.peek(s.id);
    assert.equal(updated.recentEvents.length, 1);
    assert.deepEqual(updated.lastEvent?.kind, "breakpoint");
    await mgr.terminate(s.id);
  });

  test("T8: wireClient stateChange updates session state fields (D2 invariants)", async () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234, 52001);
    const fakeClient = new EventEmitter();
    mgr.wireClient(s.id, fakeClient);

    fakeClient.emit("stateChange", {
      state: "paused",
      pauseReason: "breakpoint",
      terminationReason: null,
    });

    const updated = mgr.peek(s.id);
    assert.equal(updated.state, "paused");
    assert.equal(updated.pauseReason, "breakpoint");
    assert.equal(updated.terminationReason, null); // D2: null when paused
    await mgr.terminate(s.id);
  });

  test("T8: D2 invariant — terminationReason null when running", async () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234, 52002);
    const fakeClient = new EventEmitter();
    mgr.wireClient(s.id, fakeClient);

    fakeClient.emit("stateChange", { state: "running", pauseReason: null, terminationReason: null });
    const updated = mgr.peek(s.id);
    assert.equal(updated.state, "running");
    assert.equal(updated.pauseReason, null); // D2: null when running
    assert.equal(updated.terminationReason, null);
    await mgr.terminate(s.id);
  });

  test("T8: stateChange signals CV — multiple concurrent waiters all wake", async () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234, 52003);
    const fakeClient = new EventEmitter();
    mgr.wireClient(s.id, fakeClient);

    const p1 = mgr.waitForStateChange(s.id, 2000);
    const p2 = mgr.waitForStateChange(s.id, 2000);
    const p3 = mgr.waitForStateChange(s.id, 2000);

    fakeClient.emit("stateChange", { state: "paused", pauseReason: "breakpoint", terminationReason: null });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(r1, true, "waiter 1 should wake on state change");
    assert.equal(r2, true, "waiter 2 should wake on state change");
    assert.equal(r3, true, "waiter 3 should wake on state change");
    await mgr.terminate(s.id);
  });

  test("T8: waitForStateChange times out → returns false", async () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234, 52004);
    const start = Date.now();
    const result = await mgr.waitForStateChange(s.id, 100);
    assert.equal(result, false);
    assert.ok(Date.now() - start >= 90, "should have waited ~100ms");
    await mgr.terminate(s.id);
  });
});

// ─── BridgeClient (offline) ───────────────────────────────────────────────────

import net from "node:net";

describe("BridgeClient (offline)", async () => {
  const { BridgeClient } = await importFresh<
    { BridgeClient: typeof import("../src/bridge.js").BridgeClient }
  >("src/bridge.ts");

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

  test("raw TCP connect rejects on unused port (ECONNREFUSED)", async () => {
    await assert.rejects(
      async () => {
        await new Promise<void>((resolve, reject) => {
          const s = net.createConnection({ port: 19999, host: "127.0.0.1" });
          s.once("connect", () => { s.destroy(); resolve(); });
          s.once("error", (e) => { s.destroy(); reject(e); });
        });
      },
      /ECONNREFUSED/
    );
  });
});

// ─── Config ───────────────────────────────────────────────────────────────────

describe("loadConfig", async () => {
  const { loadConfig } = await importFresh<
    typeof import("../src/config.js")
  >("src/config.ts");

  test("returns default bridge port 27042", () => {
    const cfg = loadConfig();
    assert.equal(cfg.bridgePort, 27042);
  });

  test("returns default bridge host 127.0.0.1", () => {
    const cfg = loadConfig();
    assert.equal(cfg.bridgeHost, "127.0.0.1");
  });

  test("defaults to stdio MCP transport", () => {
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_HTTP_HOST;
    delete process.env.MCP_HTTP_PORT;

    const cfg = loadConfig();
    assert.equal(cfg.mcpTransport, "stdio");
    assert.equal(cfg.mcpHttpHost, "127.0.0.1");
    assert.equal(cfg.mcpHttpPort, 3602);
  });

  test("reads HTTP MCP transport env overrides", () => {
    process.env.MCP_TRANSPORT = "streamable-http";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    process.env.MCP_HTTP_PORT = "4100";

    const cfg = loadConfig();
    assert.equal(cfg.mcpTransport, "streamable-http");
    assert.equal(cfg.mcpHttpHost, "0.0.0.0");
    assert.equal(cfg.mcpHttpPort, 4100);

    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_HTTP_HOST;
    delete process.env.MCP_HTTP_PORT;
  });

  test("accepts legacy http env alias", () => {
    process.env.MCP_TRANSPORT = "http";

    const cfg = loadConfig();
    assert.equal(cfg.mcpTransport, "streamable-http");

    delete process.env.MCP_TRANSPORT;
  });

  test("x64dbgPath resolves to a non-empty string", async () => {
    const cfg = loadConfig();
    assert.equal(typeof cfg.x64dbgPath, "string");
    assert.ok(cfg.x64dbgPath.length > 0, "x64dbgPath should not be empty");
    // Only verify the directory exists when running locally (e.g. when
    // X64DBG_PATH is explicitly set or the bundled x64dbg has been downloaded).
    // CI runners may not have x64dbg installed at the default path.
    if (process.env.X64DBG_PATH) {
      const fs = await import("node:fs");
      assert.ok(
        fs.existsSync(cfg.x64dbgPath),
        `x64dbgPath not found: ${cfg.x64dbgPath}`
      );
    }
  });

  test("BRIDGE_PORT env overrides default", () => {
    process.env.BRIDGE_PORT = "12345";
    const cfg = loadConfig();
    assert.equal(cfg.bridgePort, 12345);
    delete process.env.BRIDGE_PORT;
  });
});

// ─── HTTP MCP transport ─────────────────────────────────────────────────────

describe("HTTP MCP transport", async () => {
  const { startHttpMcpServer } = await importFresh<
    typeof import("../src/httpServer.js")
  >("src/httpServer.ts");
  const { createMcpServer } = await importFresh<
    typeof import("../src/mcpServer.js")
  >("src/mcpServer.ts");

  test("initializes over streamable HTTP and lists tools", async () => {
    const httpServer = await startHttpMcpServer({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      createServer: createMcpServer,
    });

    const client = new Client({ name: "http-transport-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${httpServer.host}:${httpServer.port}${httpServer.path}`)
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();

      assert.ok(result.tools.length > 0, "Expected at least one MCP tool over HTTP");
      assert.ok(
        result.tools.some((tool) => tool.name === "load_executable"),
        "Expected load_executable to be exposed over HTTP"
      );
    } finally {
      await transport.close();
      await client.close();
      await httpServer.close();
    }
  });
});

// ─── BridgeClient (mock TCP server) ──────────────────────────────────────────

/**
 * Spin up a real loopback TCP server that speaks the newline-delimited JSON
 * protocol used by the Python bridge. Returns server + port.
 * The server echoes success:true for any auth-passing request.
 */
function createMockBridge(token: string): Promise<{ server: net.Server; port: number; pendingError?: Record<string, unknown> }> {
  let pendingError: Record<string, unknown> | undefined;
  const ctx = { server: null as unknown as net.Server, port: 0, get pendingError() { return pendingError; }, set pendingError(v) { pendingError = v; } };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req: Record<string, unknown>;
        try { req = JSON.parse(line); } catch { continue; }
        const reqToken = String(req["authToken"] ?? "");
        if (reqToken !== token) {
          sock.write(JSON.stringify({ id: req["id"], success: false, error: "Unauthorized" }) + "\n");
          continue;
        }
        const ans = pendingError ? { ...pendingError, id: req["id"] } : { id: req["id"], success: true, data: { pong: true } };
        pendingError = undefined;
        sock.write(JSON.stringify(ans) + "\n");
      }
    });
  });
  return new Promise<typeof ctx>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      ctx.server = server;
      ctx.port = addr.port;
      resolve(ctx);
    });
  });
}

describe("BridgeClient (mock TCP server)", async () => {
  const { BridgeClient } = await importFresh<
    { BridgeClient: typeof import("../src/bridge.js").BridgeClient }
  >("src/bridge.ts");

  const TOKEN = "mock-secret-123";

  test("protocol: server receives valid JSON with authToken field", async () => {
    // Low-level TCP test — validate the wire format without going through BridgeClient
    const { server, port } = await createMockBridge(TOKEN);
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" });
        const req = JSON.stringify({ id: "t1", method: "ping", params: {}, authToken: TOKEN }) + "\n";
        sock.once("connect", () => sock.write(req));
        sock.once("data", (data) => {
          try {
            const res = JSON.parse(data.toString().trim());
            assert.equal(res.id, "t1");
            assert.equal(res.success, true);
            sock.destroy();
            resolve();
          } catch (e) { sock.destroy(); reject(e); }
        });
        sock.once("error", (e) => { sock.destroy(); reject(e); });
        sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("TCP timeout")); });
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("protocol: server rejects request with wrong auth token", async () => {
    const { server, port } = await createMockBridge("correct-token");
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ port, host: "127.0.0.1" });
        const req = JSON.stringify({ id: "t2", method: "ping", params: {}, authToken: "wrong" }) + "\n";
        sock.once("connect", () => sock.write(req));
        sock.once("data", (data) => {
          try {
            const res = JSON.parse(data.toString().trim());
            assert.equal(res.success, false);
            assert.match(res.error, /Unauthorized/);
            sock.destroy();
            resolve();
          } catch (e) { sock.destroy(); reject(e); }
        });
        sock.once("error", reject);
        sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("TCP timeout")); });
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("protocol: multiple sequential requests are matched by id", async () => {
    const { server, port } = await createMockBridge(TOKEN);
    try {
      await new Promise<void>((resolve, reject) => {
        const results: Record<string, unknown>[] = [];
        const sock = net.createConnection({ port, host: "127.0.0.1" });
        let buf = "";
        sock.once("connect", () => {
          sock.write(JSON.stringify({ id: "r1", method: "ping", params: {}, authToken: TOKEN }) + "\n");
          sock.write(JSON.stringify({ id: "r2", method: "ping", params: {}, authToken: TOKEN }) + "\n");
        });
        sock.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try { results.push(JSON.parse(line)); } catch { /* skip */ }
            if (results.length === 2) {
              sock.destroy();
              try {
                const ids = results.map((r) => r["id"] as string).sort();
                assert.deepEqual(ids, ["r1", "r2"]);
                resolve();
              } catch (e) { reject(e); }
            }
          }
        });
        sock.once("error", reject);
        sock.setTimeout(3000, () => { sock.destroy(); reject(new Error("TCP timeout")); });
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ─── BridgeClient T7 — event dispatch + protocol.probe handshake ─────────────

/**
 * Mock bridge that understands protocol.probe (v2) and optionally sends
 * unsolicited push frames after the probe response.
 */
function createV2MockBridge(opts: {
  probeVersion?: string;   // version to report; default "2"
  probeError?: string;     // if set, return this error for protocol.probe
  pushFrames?: unknown[];  // unsolicited frames sent after probe response
}): Promise<{ server: net.Server; port: number }> {
  const { probeVersion = "2", probeError, pushFrames = [] } = opts;
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req: Record<string, unknown>;
        try { req = JSON.parse(line); } catch { continue; }
        if (req["method"] === "protocol.probe") {
          if (probeError) {
            sock.write(JSON.stringify({ id: req["id"], success: false, error: probeError }) + "\n");
          } else {
            sock.write(JSON.stringify({
              id: req["id"], success: true,
              data: { protocolVersion: probeVersion, capabilities: ["protocol.probe"] },
            }) + "\n");
            for (const frame of pushFrames) {
              sock.write(JSON.stringify(frame) + "\n");
            }
          }
        } else {
          sock.write(JSON.stringify({ id: req["id"], success: true, data: {} }) + "\n");
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

describe("BridgeClient T7 — event dispatch + protocol.probe", async () => {
  const { BridgeClient } = await importFresh<
    { BridgeClient: typeof import("../src/bridge.js").BridgeClient }
  >("src/bridge.ts");

  test("T7: routes debugEvent push frames via emit('debugEvent')", async () => {
    const pushFrames = [
      { type: "debugEvent", event: { kind: "breakpoint", address: "0x401000" } },
      { type: "debugEvent", event: { kind: "step", address: "0x401001" } },
    ];
    const { server, port } = await createV2MockBridge({ pushFrames });
    const b = new BridgeClient("127.0.0.1", port);
    const events: unknown[] = [];
    b.on("debugEvent", (e) => events.push(e));
    try {
      await b.connect();
      await new Promise<void>((r) => setTimeout(r, 100)); // let frames arrive
      assert.equal(events.length, 2, `expected 2 debugEvent, got ${events.length}`);
      assert.deepEqual((events[0] as Record<string, unknown>)["kind"], "breakpoint");
      assert.deepEqual((events[1] as Record<string, unknown>)["kind"], "step");
    } finally {
      await b.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("T7: routes stateChange push frames via emit('stateChange')", async () => {
    const pushFrames = [
      { type: "stateChange", state: { state: "paused", pauseReason: "breakpoint" } },
    ];
    const { server, port } = await createV2MockBridge({ pushFrames });
    const b = new BridgeClient("127.0.0.1", port);
    const states: unknown[] = [];
    b.on("stateChange", (s) => states.push(s));
    try {
      await b.connect();
      await new Promise<void>((r) => setTimeout(r, 100));
      assert.equal(states.length, 1);
      assert.deepEqual((states[0] as Record<string, unknown>)["state"], "paused");
    } finally {
      await b.disconnect();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("T7: protocol.probe version mismatch → connect() rejects with E_PROTOCOL_VERSION", async () => {
    const { server, port } = await createV2MockBridge({ probeVersion: "99" });
    const b = new BridgeClient("127.0.0.1", port);
    try {
      await assert.rejects(
        () => b.connect(),
        /E_PROTOCOL_VERSION/,
      );
    } finally {
      await b.disconnect().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("T7: protocol.probe error → connect() rejects with E_PROTOCOL_VERSION", async () => {
    const { server, port } = await createV2MockBridge({ probeError: "E_PROTOCOL_VERSION" });
    const b = new BridgeClient("127.0.0.1", port);
    try {
      await assert.rejects(
        () => b.connect(),
        /E_PROTOCOL_VERSION/,
      );
    } finally {
      await b.disconnect().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ─── ErrorCode / McpError ────────────────────────────────────────────────────

describe("ErrorCode and McpError", async () => {
  const { ErrorCode, McpError } = await importFresh<
    typeof import("../src/errors.js")
  >("src/errors.ts");

  test("McpError carries code and message", () => {
    const err = new McpError(ErrorCode.E_NOT_DEBUGGING, "not debugging");
    assert.equal(err.code, "E_NOT_DEBUGGING");
    assert.equal(err.message, "not debugging");
    assert.equal(err.name, "McpError");
    assert.ok(err instanceof Error);
  });

  test("all ErrorCode values are unique strings", () => {
    const vals = Object.values(ErrorCode);
    const unique = new Set(vals);
    assert.equal(unique.size, vals.length, "duplicate error code detected");
  });

  test("E_PORT_EXHAUSTED is registered", () => {
    assert.equal(ErrorCode.E_PORT_EXHAUSTED, "E_PORT_EXHAUSTED");
  });

  test("v1.2.0 new error codes are registered", () => {
    assert.equal(ErrorCode.E_PROTOCOL_VERSION, "E_PROTOCOL_VERSION");
    assert.equal(ErrorCode.E_SESSION_TERMINATED, "E_SESSION_TERMINATED");
    assert.equal(ErrorCode.E_IO_FAILED, "E_IO_FAILED");
  });
});

// ─── v1.2.0 type vocabulary (D3 spec) ────────────────────────────────────────

describe("v1.2.0 type vocabulary", async () => {
  const types = await importFresh<typeof import("../src/types.js")>("src/types.ts");

  test("PauseReason enum (D3) has all 13 values", () => {
    // Runtime enum-like constant lets us iterate; the type union must match it.
    const expected = [
      "breakpoint",
      "step",
      "exception",
      "tls_callback",
      "system_breakpoint",
      "manual_pause",
      "trace_terminated",
      "dll_load_break",
      "dll_unload_break",
      "thread_create_break",
      "thread_exit_break",
      "output_debug_break",
      "unknown",
    ].sort();
    const actual = [...(types.PAUSE_REASONS as readonly string[])].sort();
    assert.deepEqual(actual, expected);
  });

  test("TerminationReason enum (D3) has all 4 values", () => {
    const expected = ["process_exit", "detached", "bridge_lost", "unknown"].sort();
    const actual = [...(types.TERMINATION_REASONS as readonly string[])].sort();
    assert.deepEqual(actual, expected);
  });

  test("DebugEventKind enum (D3) has all 15 values", () => {
    const expected = [
      "breakpoint",
      "step",
      "exception",
      "tls_callback",
      "dll_load",
      "dll_unload",
      "thread_create",
      "thread_exit",
      "process_create",
      "process_exit",
      "system_breakpoint",
      "manual_pause",
      "output_debug_string",
      "trace_terminated",
      "detached",
    ].sort();
    const actual = [...(types.DEBUG_EVENT_KINDS as readonly string[])].sort();
    assert.deepEqual(actual, expected);
  });

  test("BpType enum (D3) has 5 values", () => {
    const expected = ["sw", "hw", "mem", "dll", "exception"].sort();
    const actual = [...(types.BP_TYPES as readonly string[])].sort();
    assert.deepEqual(actual, expected);
  });

  test("BpKind enum (D3) has 3 values", () => {
    const expected = ["user", "temporary", "system"].sort();
    const actual = [...(types.BP_KINDS as readonly string[])].sort();
    assert.deepEqual(actual, expected);
  });

  test("DebugState (D2) narrowed to 4 values", () => {
    const expected = ["loading", "running", "paused", "terminated"].sort();
    const actual = [...(types.DEBUG_STATES as readonly string[])].sort();
    assert.deepEqual(actual, expected);
  });
});

// ─── logToolCall helper ────────────────────────────────────────────────────────

describe("logToolCall helper", async () => {
  const { logToolCall } = await importFresh<
    typeof import("../src/logger.js")
  >("src/logger.ts");

  test("logToolCall is a function", () => {
    assert.equal(typeof logToolCall, "function");
  });

  test("logToolCall does not throw on success path", () => {
    assert.doesNotThrow(() => logToolCall("read_memory", "sess-1", 12));
  });

  test("logToolCall does not throw on error path", () => {
    assert.doesNotThrow(() => logToolCall("read_memory", "sess-1", 5, "some error"));
  });
});

// ─── BridgeRegistry ───────────────────────────────────────────────────────────

describe("BridgeRegistry", async () => {
  const { BridgeRegistry } = await importFresh<
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
    const c1 = new BridgeClient("127.0.0.1", 1);
    const c2 = new BridgeClient("127.0.0.1", 2);
    r.set("a", c1);
    r.set("b", c2);
    const all = r.list();
    assert.equal(all.length, 2);
    assert.ok(all.includes(c1) && all.includes(c2));
  });
});
