import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../../src/service/status-formatter.js";
import type { StatusViewModel } from "../../src/service/types.js";

describe("status-formatter", () => {
  test("renders not-installed message", () => {
    const vm: StatusViewModel = { name: "x64dbg-mcp", installed: false };
    const out = formatStatus(vm);
    assert.match(out, /Service:\s+x64dbg-mcp\s+\(not installed\)/);
    assert.match(out, /service install --port 3602/);
  });

  test("renders RUNNING with health OK", () => {
    const vm: StatusViewModel = {
      name: "x64dbg-mcp",
      installed: true,
      scm: {
        installed: true,
        state: "RUNNING",
        pid: 1234,
        startedAt: "2026-05-08 14:22:11",
        identityAccount: "LocalSystem",
        scmStartType: "auto",
      },
      record: {
        installPath: "C:\\foo\\dist\\server.js",
        port: 3602,
        host: "127.0.0.1",
        version: "1.2.0",
        installedAt: "2026-05-08T00:00:00Z",
        displayName: "x64dbg MCP Server",
        startType: "auto",
      },
      health: { ok: true, durationMs: 42 },
      endpoint: "http://127.0.0.1:3602/mcp",
      packageVersion: "1.2.0",
    };
    const out = formatStatus(vm);
    assert.match(out, /State:\s+RUNNING/);
    assert.match(out, /\(Automatic, started 2026-05-08 14:22:11\)/);
    assert.match(out, /PID:\s+1234/);
    assert.match(out, /Endpoint:\s+http:\/\/127\.0\.0\.1:3602\/mcp/);
    assert.match(out, /Health:\s+OK \(initialize 42ms\)/);
    assert.match(out, /Identity:\s+LocalSystem/);
    assert.match(out, /Version:\s+1\.2\.0/);
  });

  test("renders STOPPED without PID/Endpoint/Health lines", () => {
    const vm: StatusViewModel = {
      name: "x64dbg-mcp",
      installed: true,
      scm: {
        installed: true,
        state: "STOPPED",
        identityAccount: "LocalSystem",
        scmStartType: "auto",
      },
      record: {
        installPath: "C:\\foo\\dist\\server.js",
        port: 3602,
        host: "127.0.0.1",
        version: "1.2.0",
        installedAt: "2026-05-08T00:00:00Z",
        displayName: "x64dbg MCP Server",
        startType: "auto",
      },
      packageVersion: "1.2.0",
    };
    const out = formatStatus(vm);
    assert.match(out, /State:\s+STOPPED/);
    assert.doesNotMatch(out, /PID:/);
    assert.doesNotMatch(out, /Endpoint:/);
    assert.doesNotMatch(out, /Health:/);
  });

  test("renders Health: FAILED when health probe failed", () => {
    const vm: StatusViewModel = {
      name: "x64dbg-mcp",
      installed: true,
      scm: {
        installed: true,
        state: "RUNNING",
        pid: 1,
        identityAccount: "LocalSystem",
        scmStartType: "auto",
      },
      record: {
        installPath: "C:\\foo\\dist\\server.js",
        port: 3602,
        host: "127.0.0.1",
        version: "1.2.0",
        installedAt: "2026-05-08T00:00:00Z",
        displayName: "x64dbg MCP Server",
        startType: "auto",
      },
      health: { ok: false, reason: "timeout" },
      endpoint: "http://127.0.0.1:3602/mcp",
      packageVersion: "1.2.0",
    };
    const out = formatStatus(vm);
    assert.match(out, /Health:\s+FAILED \(timeout\)/);
  });
});
