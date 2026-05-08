import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkHealth } from "../../src/service/health-check.js";

function startTinyServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) throw new Error("no address");
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe("health-check", () => {
  test("returns ok=true when initialize succeeds", async () => {
    const { port, close } = await startTinyServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fake-session" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", serverInfo: { name: "x", version: "0" }, capabilities: {} } }));
      });
    });
    try {
      const result = await checkHealth({ host: "127.0.0.1", port, timeoutMs: 2000 });
      assert.equal(result.ok, true);
      assert.equal(typeof result.durationMs, "number");
    } finally {
      await close();
    }
  });

  test("returns ok=false on non-200", async () => {
    const { port, close } = await startTinyServer((_req, res) => {
      res.writeHead(500);
      res.end("oops");
    });
    try {
      const result = await checkHealth({ host: "127.0.0.1", port, timeoutMs: 2000 });
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /HTTP 500/);
    } finally {
      await close();
    }
  });

  test("returns ok=false on timeout", async () => {
    const { port, close } = await startTinyServer(() => {
      // Never respond.
    });
    try {
      const result = await checkHealth({ host: "127.0.0.1", port, timeoutMs: 200 });
      assert.equal(result.ok, false);
      assert.match(result.reason ?? "", /timeout/i);
    } finally {
      await close();
    }
  });

  test("returns ok=false on connection refused", async () => {
    const result = await checkHealth({ host: "127.0.0.1", port: 1, timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /ECONNREFUSED|connect/i);
  });
});
