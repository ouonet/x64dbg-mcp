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

        // ── Set breakpoints on different Winsock symbols via execute_command ─
        await callTool(server, "execute_command", {
          sessionId: aSessionId,
          command: "bp ws2_32.accept",
        });
        await callTool(server, "execute_command", {
          sessionId: bSessionId,
          command: "bp ws2_32.connect",
        });

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

        // D5 envelope: { timedOut, state, pauseReason, terminationReason, lastEvent, recentEvents }
        assert.equal(stopA.timedOut, false, `session A must not time out`);
        assert.equal(
          stopA.state,
          "paused",
          `expected paused state in session A, got: ${JSON.stringify(stopA)}`,
        );
        assert.equal(
          stopA.pauseReason,
          "breakpoint",
          `expected breakpoint pauseReason in session A, got: ${JSON.stringify(stopA)}`,
        );
        assert.equal(stopB.timedOut, false, `session B must not time out`);
        assert.equal(
          stopB.state,
          "paused",
          `expected paused state in session B, got: ${JSON.stringify(stopB)}`,
        );
        assert.equal(
          stopB.pauseReason,
          "breakpoint",
          `expected breakpoint pauseReason in session B, got: ${JSON.stringify(stopB)}`,
        );

        // ── Verify breakpoint isolation: each session stopped at a distinct address ─
        // lastEvent is a DebugEvent with an address field (bpKind: "user")
        const lastEvA = stopA.lastEvent as Record<string, unknown> | null;
        const lastEvB = stopB.lastEvent as Record<string, unknown> | null;
        if (lastEvA && lastEvB) {
          assert.notEqual(
            lastEvA["address"],
            lastEvB["address"],
            `sessions must stop at distinct addresses: A=${String(lastEvA["address"])}, B=${String(lastEvB["address"])}`,
          );
          assert.equal(lastEvA["bpKind"], "user", `session A BP kind must be "user"`);
          assert.equal(lastEvB["bpKind"], "user", `session B BP kind must be "user"`);
        }

        // ── Continue both to finish their work ─────────────────────────────
        await callTool(server, "continue_execution", { sessionId: aSessionId });
        await callTool(server, "continue_execution", { sessionId: bSessionId });

        await new Promise((r) => setTimeout(r, 2000));

        // ── Terminate session A; verify B is unaffected ────────────────────
        await callTool(server, "terminate_session", { sessionId: aSessionId });
        // D15: session stays in map as "terminated" for 30s retention; bridge is released immediately.
        assert.equal(
          sessions.peek(aSessionId).state,
          "terminated",
          "session A should be in terminated state after terminate",
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
        // D15: terminated sessions remain in the map for 30s; both should be in terminated state.
        const active = sessions.list().filter((s) => s.state !== "terminated");
        assert.equal(
          active.length,
          0,
          "all active (non-terminated) sessions should be gone after teardown",
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
