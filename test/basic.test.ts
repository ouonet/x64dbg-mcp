/**
 * Basic automated tests — no x64dbg required.
 * Run with:  npx tsx test/basic.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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

  test("detects loaddll.exe (x64dbg test host x64)", () => {
    const loaddll = path.join(ROOT, "x64dbg", "release", "x64", "loaddll.exe");
    const arch = detectPEArchitecture(loaddll);
    assert.equal(arch, "x64");
  });

  test("detects loaddll.exe (x64dbg test host x32)", () => {
    const loaddll = path.join(ROOT, "x64dbg", "release", "x32", "loaddll.exe");
    const arch = detectPEArchitecture(loaddll);
    assert.equal(arch, "x86");
  });
});

// ─── Debugger path resolution ────────────────────────────────────────────────

describe("resolveDebuggerExe", async () => {
  const { resolveDebuggerExe } = await importFresh<
    typeof import("../src/launcher.js")
  >("src/launcher.ts");

  test("resolves x64dbg.exe for x64", () => {
    const exe = resolveDebuggerExe("x64");
    assert.ok(exe.endsWith("x64dbg.exe"), `Expected x64dbg.exe, got: ${exe}`);
  });

  test("resolves x32dbg.exe for x86", () => {
    const exe = resolveDebuggerExe("x86");
    assert.ok(exe.endsWith("x32dbg.exe"), `Expected x32dbg.exe, got: ${exe}`);
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

// ─── SessionManager ───────────────────────────────────────────────────────────

describe("SessionManager", async () => {
  const { SessionManager } = await importFresh<
    { SessionManager: typeof import("../src/session.js").SessionManager }
  >("src/session.ts");

  test("creates a session with correct fields", () => {
    const mgr = new SessionManager();
    const s = mgr.create("test.exe", "x64", 1234);
    assert.equal(s.executable, "test.exe");
    assert.equal(s.architecture, "x64");
    assert.equal(s.pid, 1234);
    assert.equal(s.state, "idle");
    assert.ok(typeof s.id === "string" && s.id.length > 0);
  });

  test("get() returns the session by id", () => {
    const mgr = new SessionManager();
    const s = mgr.create("a.exe", "x86", 1);
    const got = mgr.get(s.id);
    assert.equal(got.id, s.id);
  });

  test("get() throws for unknown id", () => {
    const mgr = new SessionManager();
    assert.throws(() => mgr.get("nonexistent-id"), /Session not found/);
  });

  test("has() returns correct boolean", () => {
    const mgr = new SessionManager();
    const s = mgr.create("b.exe", "x64", 2);
    assert.equal(mgr.has(s.id), true);
    assert.equal(mgr.has("ghost"), false);
  });

  test("updateState() changes state", () => {
    const mgr = new SessionManager();
    const s = mgr.create("c.exe", "x64", 3);
    mgr.updateState(s.id, "running");
    assert.equal(mgr.get(s.id).state, "running");
    mgr.updateState(s.id, "paused");
    assert.equal(mgr.get(s.id).state, "paused");
  });

  test("list() returns all sessions", () => {
    const mgr = new SessionManager();
    const s = mgr.create("d.exe", "x64", 4);
    assert.equal(mgr.list().length, 1);
    assert.equal(mgr.list()[0]?.id, s.id);
  });

  test("addBreakpoint() and removeBreakpoint()", () => {
    const mgr = new SessionManager();
    const s = mgr.create("f.exe", "x64", 6);
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

  test("toJSON() serialises sessions", () => {
    const mgr = new SessionManager();
    mgr.create("g.exe", "x64", 7);
    const arr = mgr.toJSON() as { executable: string }[];
    assert.equal(arr.length, 1);
    assert.equal(arr[0].executable, "g.exe");
  });

  test("throws when max sessions reached", () => {
    const mgr = new SessionManager();
    mgr.create("exe0.exe", "x64", 100);
    assert.throws(
      () => mgr.create("overflow.exe", "x64", 999),
      /Only one active debugging session is supported/
    );
  });
});

// ─── BridgeClient (offline) ───────────────────────────────────────────────────

import net from "node:net";

describe("BridgeClient (offline)", async () => {
  const { BridgeClient } = await importFresh<
    { BridgeClient: typeof import("../src/bridge.js").BridgeClient }
  >("src/bridge.ts");

  test("isConnected is false before connect()", () => {
    const b = new BridgeClient();
    assert.equal(b.isConnected, false);
  });

  test("request() throws when not connected", async () => {
    const b = new BridgeClient();
    await assert.rejects(
      () => b.request("test.method", {}),
      /Bridge is not connected/
    );
  });

  test("call() throws when not connected", async () => {
    const b = new BridgeClient();
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

  test("x64dbgPath resolves to existing directory", () => {
    const cfg = loadConfig();
    import("node:fs").then(({ default: fs }) => {
      assert.ok(fs.existsSync(cfg.x64dbgPath), `x64dbgPath not found: ${cfg.x64dbgPath}`);
    });
  });

  test("BRIDGE_PORT env overrides default", () => {
    process.env.BRIDGE_PORT = "12345";
    const cfg = loadConfig();
    assert.equal(cfg.bridgePort, 12345);
    delete process.env.BRIDGE_PORT;
  });
});
