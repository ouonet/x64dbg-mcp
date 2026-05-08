/**
 * Multi-session integration test.
 *
 * Runs ONLY when:
 *   - x64dbg binaries are present at the expected default location
 *   - Fixtures have been built (run `npm run build:fixtures`)
 *
 * Verifies:
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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const SERVER_EXE = path.join(
  ROOT,
  "test",
  "fixtures",
  "build",
  "Release",
  "http_server.exe",
);
const CLIENT_EXE = path.join(
  ROOT,
  "test",
  "fixtures",
  "build",
  "Release",
  "http_client.exe",
);
const X64DBG_EXE = path.join(
  ROOT,
  "x64dbg",
  "release",
  "x64",
  "x64dbg.exe",
);

const PREREQS_MET =
  fs.existsSync(SERVER_EXE) &&
  fs.existsSync(CLIENT_EXE) &&
  fs.existsSync(X64DBG_EXE);

async function importFresh<T>(relPath: string): Promise<T> {
  const abs = path.join(ROOT, relPath).replace(/\\/g, "/");
  return import(`file:///${abs}`) as Promise<T>;
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => {
      srv.close();
      resolve(false);
    });
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/**
 * Plain-object view of the McpServer internals.
 * We cast via `unknown` to avoid the TypeScript intersection-narrowing issue
 * that occurs when intersecting with a class that already declares
 * `_registeredTools` as private.
 */
interface McpServerInternalShape {
  _registeredTools: Record<
    string,
    {
      handler: (
        args: Record<string, unknown>,
        extra: Record<string, unknown>,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        isError?: boolean;
      }>;
      inputSchema?: unknown;
      enabled?: boolean;
    }
  >;
}

/**
 * Invoke a registered MCP tool by name, bypassing the wire protocol.
 * Reaches into the SDK's internal `_registeredTools` map and calls `handler`
 * directly with the given args.
 */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const internal = server as unknown as McpServerInternalShape;
  const tools = internal._registeredTools;
  if (!tools) {
    throw new Error(
      `McpServer does not expose _registeredTools — SDK shape may have changed`,
    );
  }
  const tool = tools[name];
  if (!tool) {
    throw new Error(`Tool not registered: ${name}`);
  }
  const res = await tool.handler(args, {});
  return { text: res.content[0]?.text ?? "", isError: res.isError };
}

/**
 * Parse a JSON tool result, throwing a descriptive error if the tool
 * returned an error response or non-JSON text.
 */
function parseToolResult(result: { text: string; isError?: boolean }, toolName: string): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`Tool '${toolName}' returned error: ${result.text}`);
  }
  try {
    return JSON.parse(result.text) as Record<string, unknown>;
  } catch {
    throw new Error(`Tool '${toolName}' returned non-JSON: ${result.text}`);
  }
}

describe(
  "multi-session integration",
  {
    skip: !PREREQS_MET
      ? "fixtures or x64dbg missing — run `npm run build:fixtures` first"
      : false,
  },
  async () => {
    const { createMcpServer } = await importFresh<
      typeof import("../../src/mcpServer.js")
    >("src/mcpServer.ts");
    const { sessions } = await importFresh<
      typeof import("../../src/session.js")
    >("src/session.ts");
    const { bridges } = await importFresh<
      typeof import("../../src/bridgeRegistry.js")
    >("src/bridgeRegistry.ts");
    const cfgMod = await importFresh<typeof import("../../src/config.js")>(
      "src/config.ts",
    );

    let server: McpServer;
    let prevMaxSessions: number;

    before(() => {
      // Override MAX_SESSIONS so the test isn't blocked by a developer's .env
      // setting it to 1 (legacy single-session value).
      prevMaxSessions = cfgMod.config.maxSessions;
      (cfgMod.config as { maxSessions: number }).maxSessions = 5;
      server = createMcpServer();
    });

    after(async () => {
      for (const s of [...sessions.list()]) {
        try {
          await sessions.terminate(s.id);
        } catch {
          /* ignore */
        }
      }
      (cfgMod.config as { maxSessions: number }).maxSessions = prevMaxSessions;
    });

    test(
      "two concurrent sessions with distinct bridge ports",
      async (t) => {
        // ── Load both executables ──────────────────────────────────────────
        const aRaw = parseToolResult(
          await callTool(server, "load_executable", {
            executablePath: SERVER_EXE,
            breakOnEntry: true,
            autoAnalyze: false,
          }),
          "load_executable",
        );
        const bRaw = parseToolResult(
          await callTool(server, "load_executable", {
            executablePath: CLIENT_EXE,
            breakOnEntry: true,
            autoAnalyze: false,
          }),
          "load_executable",
        );
        const aSessionId = aRaw.sessionId as string;
        const aPort = aRaw.bridgePort as number;
        const bSessionId = bRaw.sessionId as string;
        const bPort = bRaw.bridgePort as number;

        t.diagnostic(`server session: ${aSessionId} (port ${aPort})`);
        t.diagnostic(`client session: ${bSessionId} (port ${bPort})`);

        // ── Two sessions, distinct ports ───────────────────────────────────
        assert.equal(sessions.list().length, 2);
        assert.notEqual(aPort, bPort);
        assert.ok(
          aPort >= 30000 && aPort <= 44999,
          `server bridgePort ${aPort} out of allocated range`,
        );
        assert.ok(
          bPort >= 30000 && bPort <= 44999,
          `client bridgePort ${bPort} out of allocated range`,
        );

        // ── Set breakpoints on different Winsock symbols ───────────────────
        const bpA = parseToolResult(
          await callTool(server, "set_breakpoint", {
            sessionId: aSessionId,
            address: "ws2_32.accept",
            type: "software",
          }),
          "set_breakpoint",
        );
        assert.equal(
          bpA.status,
          "breakpoint_set",
          `expected breakpoint_set for session A, got: ${JSON.stringify(bpA)}`,
        );

        const bpB = parseToolResult(
          await callTool(server, "set_breakpoint", {
            sessionId: bSessionId,
            address: "ws2_32.connect",
            type: "software",
          }),
          "set_breakpoint",
        );
        assert.equal(
          bpB.status,
          "breakpoint_set",
          `expected breakpoint_set for session B, got: ${JSON.stringify(bpB)}`,
        );

        // ── Continue both in parallel ──────────────────────────────────────
        const contA = callTool(server, "continue_execution", {
          sessionId: aSessionId,
        });
        // Stagger slightly so the server has time to bind its socket
        await new Promise((r) => setTimeout(r, 1500));
        const contB = callTool(server, "continue_execution", {
          sessionId: bSessionId,
        });

        const [resA, resB] = await Promise.all([contA, contB]);
        const stopA = parseToolResult(resA, "continue_execution");
        const stopB = parseToolResult(resB, "continue_execution");
        t.diagnostic(`server stop: ${JSON.stringify(stopA)}`);
        t.diagnostic(`client stop: ${JSON.stringify(stopB)}`);

        assert.equal(
          stopA.stopReason,
          "breakpoint",
          `expected breakpoint stop in session A, got: ${JSON.stringify(stopA)}`,
        );
        assert.equal(
          stopB.stopReason,
          "breakpoint",
          `expected breakpoint stop in session B, got: ${JSON.stringify(stopB)}`,
        );

        // ── Verify breakpoint isolation ────────────────────────────────────
        // list_breakpoints returns the resolved hex address per session.
        // We don't trust the symbolic address echoed by set_breakpoint — it may
        // pass through unchanged on some bridge versions. The ground truth is
        // that each session has exactly one BP at a distinct concrete address.
        const bpsA = parseToolResult(
          await callTool(server, "list_breakpoints", { sessionId: aSessionId }),
          "list_breakpoints",
        );
        const bpsB = parseToolResult(
          await callTool(server, "list_breakpoints", { sessionId: bSessionId }),
          "list_breakpoints",
        );

        const addrsA: string[] = (bpsA.breakpoints as Array<{ address: string }>).map(
          (bp) => bp.address.toLowerCase(),
        );
        const addrsB: string[] = (bpsB.breakpoints as Array<{ address: string }>).map(
          (bp) => bp.address.toLowerCase(),
        );

        assert.equal(addrsA.length, 1, `session A must have exactly 1 BP: ${JSON.stringify(addrsA)}`);
        assert.equal(addrsB.length, 1, `session B must have exactly 1 BP: ${JSON.stringify(addrsB)}`);
        assert.notEqual(addrsA[0], addrsB[0], `BPs must be at distinct addresses: A=${addrsA[0]}, B=${addrsB[0]}`);
        assert.ok(
          !addrsA.includes(addrsB[0]!),
          `session A must not contain session B's BP (${addrsB[0]}), got: ${JSON.stringify(addrsA)}`,
        );
        assert.ok(
          !addrsB.includes(addrsA[0]!),
          `session B must not contain session A's BP (${addrsA[0]}), got: ${JSON.stringify(addrsB)}`,
        );

        // Suppress unused-binding warning (bpA/bpB reserved for future symbol-resolution checks)
        void bpA; void bpB;

        // ── Continue both to finish their work ─────────────────────────────
        await callTool(server, "continue_execution", { sessionId: aSessionId });
        await callTool(server, "continue_execution", { sessionId: bSessionId });

        await new Promise((r) => setTimeout(r, 2000));

        // ── Terminate session A; verify B is unaffected ────────────────────
        await callTool(server, "terminate_session", { sessionId: aSessionId });
        assert.equal(
          sessions.has(aSessionId),
          false,
          "session A should be gone after terminate",
        );
        assert.equal(
          bridges.has(aSessionId),
          false,
          "bridge A should be released after terminate",
        );

        const statusB = parseToolResult(
          await callTool(server, "get_status", { sessionId: bSessionId }),
          "get_status",
        );
        assert.ok(
          statusB.session,
          "session B status should still be available after session A terminated",
        );

        // ── Terminate session B ────────────────────────────────────────────
        await callTool(server, "terminate_session", { sessionId: bSessionId });
        assert.equal(
          sessions.list().length,
          0,
          "all sessions should be gone after teardown",
        );

        // ── Port A should be released ──────────────────────────────────────
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(
          await isPortFree(aPort),
          true,
          `port ${aPort} should be released after session A terminated`,
        );
      },
    );
  },
);
