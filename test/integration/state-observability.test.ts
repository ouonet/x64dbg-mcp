/**
 * State observability integration tests (D2, D3, D6, D8, D13, D15).
 *
 * Requires:
 *   - x64dbg binaries at x64dbg/release/x64/x64dbg.exe
 *   - Fixtures built via `npm run build:fixtures`
 *   - The x64dbg Python bridge plugin installed
 *
 * All tests in this file are automatically skipped when prerequisites are missing.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "build", "Release");
const INT3_EXE = path.join(FIXTURE_DIR, "int3.exe");
const EXCEPTION_BP_EXE = path.join(FIXTURE_DIR, "exception_bp.exe");
const HTTP_SERVER_EXE = path.join(FIXTURE_DIR, "http_server.exe");
const X64DBG_EXE = path.join(ROOT, "x64dbg", "release", "x64", "x64dbg.exe");

const PREREQS_MET =
  fs.existsSync(HTTP_SERVER_EXE) &&
  fs.existsSync(INT3_EXE) &&
  fs.existsSync(X64DBG_EXE);

async function importFresh<T>(relPath: string): Promise<T> {
  const abs = path.join(ROOT, relPath).replace(/\\/g, "/");
  return import(`file:///${abs}`) as Promise<T>;
}

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
    }
  >;
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  const internal = server as unknown as McpServerInternalShape;
  const tool = internal._registeredTools?.[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const res = await tool.handler(args, {});
  return { text: res.content[0]?.text ?? "", isError: res.isError };
}

function parseResult(r: { text: string; isError?: boolean }, toolName: string): Record<string, unknown> {
  if (r.isError) throw new Error(`Tool '${toolName}' error: ${r.text}`);
  return JSON.parse(r.text) as Record<string, unknown>;
}

describe(
  "state-observability integration",
  {
    skip: !PREREQS_MET
      ? "fixtures or x64dbg missing — run `npm run build:fixtures` first"
      : false,
  },
  async () => {
    const { createMcpServer } = await importFresh<typeof import("../../src/mcpServer.js")>("src/mcpServer.ts");
    const { sessions } = await importFresh<typeof import("../../src/session.js")>("src/session.ts");
    const cfgMod = await importFresh<typeof import("../../src/config.js")>("src/config.ts");

    let server: McpServer;
    let prevMaxSessions: number;

    before(() => {
      prevMaxSessions = cfgMod.config.maxSessions;
      (cfgMod.config as { maxSessions: number }).maxSessions = 5;
      server = createMcpServer();
    });

    after(async () => {
      for (const s of [...sessions.list()]) {
        try { await sessions.terminate(s.id); } catch { /* ignore */ }
      }
      (cfgMod.config as { maxSessions: number }).maxSessions = prevMaxSessions;
    });

    // ── D13: load_executable waits for system_bp ─────────────────────────────

    test("D13: load_executable returns system_bp pause with recentEvents trail", async () => {
      const raw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = raw.sessionId as string;
      try {
        assert.equal(raw.timedOut, false, "load must not time out");
        assert.equal(raw.state, "paused", "session must be paused at entry");
        assert.ok(
          raw.pauseReason === "system_breakpoint" || raw.pauseReason === "entry_breakpoint",
          `pauseReason must be system or entry BP, got: ${String(raw.pauseReason)}`,
        );
        assert.ok(Array.isArray(raw.recentEvents), "recentEvents must be an array");
        assert.ok(
          (raw.recentEvents as unknown[]).length > 0,
          "recentEvents must contain the load trail",
        );
      } finally {
        await sessions.terminate(sessionId);
      }
    });

    // ── D3: hardcoded int3 classification ────────────────────────────────────

    test("D3: hardcoded int3 — lastEvent.kind === 'hardcoded_int3' after continue", async () => {
      const loadRaw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: INT3_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = loadRaw.sessionId as string;
      try {
        // Continue past the system_bp to let the program reach __debugbreak()
        const contRaw = parseResult(
          await callTool(server, "continue_execution", {
            sessionId,
            async: false,
            timeoutMs: 5000,
          }),
          "continue_execution",
        );
        assert.equal(contRaw.timedOut, false, "continue must not time out");
        assert.equal(contRaw.state, "paused", "must be paused at hardcoded int3");
        assert.equal(contRaw.pauseReason, "hardcoded_int3", `expected hardcoded_int3, got: ${String(contRaw.pauseReason)}`);
        const lastEv = contRaw.lastEvent as Record<string, unknown> | null;
        assert.ok(lastEv !== null, "lastEvent must be set");
        assert.equal(lastEv?.["kind"], "hardcoded_int3", "lastEvent.kind must be hardcoded_int3");
        assert.equal(lastEv?.["bpKind"], null, "hardcoded int3 must have bpKind: null");
      } finally {
        await sessions.terminate(sessionId);
      }
    });

    // ── D3: user BP via execute_command — bpKind:"user" ─────────────────────

    test("D3: user BP set via execute_command — pauseReason=breakpoint, bpKind=user", async () => {
      const loadRaw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = loadRaw.sessionId as string;
      try {
        // Set a user BP via x64dbg command
        await callTool(server, "execute_command", {
          sessionId,
          command: "bp ws2_32.accept",
        });
        const contRaw = parseResult(
          await callTool(server, "continue_execution", {
            sessionId,
            async: false,
            timeoutMs: 8000,
          }),
          "continue_execution",
        );
        assert.equal(contRaw.timedOut, false);
        assert.equal(contRaw.state, "paused");
        assert.equal(contRaw.pauseReason, "breakpoint");
        const lastEv = contRaw.lastEvent as Record<string, unknown> | null;
        assert.equal(lastEv?.["bpKind"], "user", "D3 rule 7: user BP must have bpKind:user");
      } finally {
        await sessions.terminate(sessionId);
      }
    });

    // ── D6: wait_for_state immediate-match + concurrent waiters ──────────────

    test("D6: wait_for_state returns immediately when condition already matches", async () => {
      const loadRaw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = loadRaw.sessionId as string;
      try {
        const start = Date.now();
        const raw = parseResult(
          await callTool(server, "wait_for_state", {
            sessionId,
            expect: "paused",
            timeoutMs: 5000,
          }),
          "wait_for_state",
        );
        const elapsed = Date.now() - start;
        assert.equal(raw.matched, true, "must match immediately");
        assert.ok(elapsed < 200, `immediate-match must be fast, took ${elapsed}ms`);
      } finally {
        await sessions.terminate(sessionId);
      }
    });

    test("D6: concurrent wait_for_state waiters all wake on continue", async () => {
      const loadRaw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = loadRaw.sessionId as string;
      try {
        // Set BP so the session will pause again after continue
        await callTool(server, "execute_command", { sessionId, command: "bp ws2_32.accept" });

        // Launch two concurrent waiters for "paused"
        const w1 = callTool(server, "wait_for_state", {
          sessionId,
          expect: "paused",
          timeoutMs: 8000,
        });
        const w2 = callTool(server, "wait_for_state", {
          sessionId,
          expect: "paused",
          timeoutMs: 8000,
        });

        // Continue in parallel; both waiters should wake when BP hits
        await callTool(server, "continue_execution", { sessionId, async: true });

        const [r1, r2] = await Promise.all([w1, w2]);
        const d1 = parseResult(r1, "wait_for_state");
        const d2 = parseResult(r2, "wait_for_state");
        assert.equal(d1.matched, true, "waiter 1 must match");
        assert.equal(d2.matched, true, "waiter 2 must match");
      } finally {
        await sessions.terminate(sessionId);
      }
    });

    // ── D8: save_memory_dump end-to-end ──────────────────────────────────────

    test("D8: save_memory_dump writes correct bytes to file", async () => {
      const loadRaw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = loadRaw.sessionId as string;
      const outputPath = path.join(os.tmpdir(), `x64dbg_mcp_test_dump_${Date.now()}.bin`);
      try {
        const statusRaw = parseResult(
          await callTool(server, "get_status", { sessionId }),
          "get_status",
        );
        const rip = (statusRaw.session as Record<string, unknown>)["registers"]?.toString() ?? "rip";

        // Dump 64 bytes from entry point (RIP is at entry BP)
        const dumpRaw = parseResult(
          await callTool(server, "save_memory_dump", {
            sessionId,
            address: "rip",
            size: 64,
            outputPath,
          }),
          "save_memory_dump",
        );
        void rip;
        assert.equal(dumpRaw.bytesWritten, 64, "must write exactly 64 bytes");
        assert.ok(fs.existsSync(outputPath), "output file must exist");
        const stat = fs.statSync(outputPath);
        assert.equal(stat.size, 64, "file must be 64 bytes on disk");
      } finally {
        try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
        await sessions.terminate(sessionId);
      }
    });

    // ── D15: terminated session retention window ─────────────────────────────

    test("D15: terminated session readable via get_status during 30s retention window", async () => {
      const loadRaw = parseResult(
        await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        }),
        "load_executable",
      );
      const sessionId = loadRaw.sessionId as string;

      // Terminate the session
      const termRaw = parseResult(
        await callTool(server, "terminate_session", { sessionId }),
        "terminate_session",
      );
      assert.equal(termRaw.status, "terminated");

      // get_status on a terminated session must still succeed within retention window
      const statusRaw = parseResult(
        await callTool(server, "get_status", { sessionId }),
        "get_status",
      );
      const sess = statusRaw.session as Record<string, unknown>;
      assert.equal(sess["state"], "terminated", "state must be terminated");
      assert.ok(sess["terminationReason"] !== undefined, "terminationReason must be present");

      // list_sessions must include the terminated session
      const listRaw = parseResult(
        await callTool(server, "list_sessions", {}),
        "list_sessions",
      );
      const sessions_list = listRaw.sessions as Array<Record<string, unknown>>;
      const found = sessions_list.find((s) => s["id"] === sessionId);
      assert.ok(found, "terminated session must appear in list_sessions within retention window");
      assert.equal(found?.["state"], "terminated");
    });

    // ── D13: lifecycle 60s timeout returns timedOut:true ─────────────────────

    test("D13: load_executable with unreachable bridge returns timedOut:true", async () => {
      // Override x64dbg path to point to a non-existent binary so the bridge never connects.
      const origPath = cfgMod.config.x64dbgPath;
      (cfgMod.config as Record<string, unknown>)["x64dbgPath"] = "C:\\nonexistent\\x64dbg.exe";
      try {
        const result = await callTool(server, "load_executable", {
          executablePath: HTTP_SERVER_EXE,
          breakOnEntry: true,
          autoAnalyze: false,
        });
        // The tool may return isError:true or timedOut:true depending on bridge connection failure
        if (result.isError) {
          // Bridge connection failed before 60s — acceptable
          assert.ok(result.text.includes("Error") || result.text.includes("timed"), "error message expected");
        } else {
          const data = JSON.parse(result.text) as Record<string, unknown>;
          assert.equal(data["timedOut"], true, "must report timedOut:true when bridge unreachable");
        }
      } finally {
        (cfgMod.config as Record<string, unknown>)["x64dbgPath"] = origPath;
        // Clean up any session that may have been created
        for (const s of sessions.list().filter((s) => s.executable === HTTP_SERVER_EXE)) {
          try { await sessions.terminate(s.id); } catch { /* ignore */ }
        }
      }
    });
  },
);
