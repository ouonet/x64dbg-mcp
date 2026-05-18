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
  rememberDebuggerForSession,
  detectProcessArchitecture,
} from "../launcher.js";
import type { Breakpoint, BreakpointType } from "../types.js";

type ToolError = { content: [{ type: "text"; text: string }]; isError: true };
type EnvelopeResult = { content: [{ type: "text"; text: string }] };

/** Assert session exists and is paused. Returns error response or null. */
function requirePaused(sessionId: string): ToolError | null {
  const s = sessions.list().find((x) => x.id === sessionId);
  if (!s) {
    return {
      content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
      isError: true,
    };
  }
  if (s.state !== "paused") {
    return {
      content: [{
        type: "text" as const,
        text: `Error: Session is currently '${s.state}'. ` +
          `Step/continue operations require the debuggee to be paused first.`,
      }],
      isError: true,
    };
  }
  return null;
}

/**
 * T12 — D5 execution envelope.
 * Fires a bridge command (fire-and-forget) then either:
 *   - async=true: returns immediately with current state snapshot
 *   - async=false: waits on the per-session state-change CV until paused or timeout
 */
async function execEnvelope(
  sessionId: string,
  bridgeMethod: string,
  bridgeParams: Record<string, unknown>,
  opts: { async?: boolean; timeoutMs?: number },
  optimisticState?: "running",
): Promise<EnvelopeResult> {
  if (optimisticState) sessions.updateState(sessionId, optimisticState);

  bridgeFor(sessionId).call(bridgeMethod, bridgeParams).catch((err: unknown) => {
    logger.warn(`${bridgeMethod} fire-and-forget error (sessionId=${sessionId}): ${err}`);
  });

  if (opts.async) {
    const s = sessions.peek(sessionId);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        timedOut: false, state: s.state, pauseReason: s.pauseReason, terminationReason: s.terminationReason,
      }, null, 2) }],
    };
  }

  const timeoutMs = opts.timeoutMs ?? 30_000;
  const woken = await sessions.waitForStateChange(sessionId, timeoutMs);
  const s = sessions.peek(sessionId);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      timedOut: !woken, state: s.state, pauseReason: s.pauseReason, terminationReason: s.terminationReason,
    }, null, 2) }],
  };
}

export function registerDebugTools(server: McpServer): void {
  // ── Load executable ───────────────────────────────────────────────────

  server.tool(
    "load_executable",
    "START HERE — load a PE executable into x64dbg and create a debugging session. " +
      "Returns { timedOut, sessionId, state, pauseReason, terminationReason, recentEvents, pid, architecture, entryPoint, ... }. " +
      "Auto-detects 32-bit vs 64-bit PE and launches x32dbg or x64dbg accordingly. " +
      "With breakOnEntry=true (default): waits until first pause (entry BP, TLS callback, or exception intercept). " +
      "With breakOnEntry=false: waits until the debuggee is actually running. " +
      "Implicit 60 s safety timeout: on timeout returns timedOut:true with state:'loading' — " +
      "call wait_for_state to keep waiting, or terminate_session to clean up. " +
      "Read recentEvents for the full load trail (DLL loads, TLS, etc.) up to the first pause. " +
      "Multiple concurrent sessions are supported (up to MAX_SESSIONS, default 5). " +
      "Each call spawns a fresh x64dbg instance on its own bridge port.",
    {
      executablePath: z
        .string()
        .describe("Absolute path to the PE executable (.exe or .dll)"),
      commandLineArgs: z
        .string()
        .optional()
        .describe("Optional command-line arguments to pass to the executable"),
      breakOnEntry: z
        .boolean()
        .default(true)
        .describe("Pause at the entry point (default true)"),
      autoAnalyze: z
        .boolean()
        .default(true)
        .describe("Run initial analysis on load (default true)"),
    },
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

        // 5. D13 — create session in "loading" state, wire push events, then fire debug.load.
        //    Push events (stateChange, debugEvent) arrive on the socket BEFORE the bridge
        //    response, so recentEvents is fully populated by the time debug.load resolves.
        const session = sessions.createLoading(executablePath, arch, port);
        bridges.set(session.id, client);
        rememberDebuggerForSession(session.id, child);
        sessions.wireClient(session.id, client);

        // 6. Fire debug.load with implicit 60 s safety timeout.
        const LIFECYCLE_TIMEOUT_MS = 60_000;
        type LoadResult = {
          pid: number;
          architecture: "x86" | "x64";
          entryPoint: string;
          modules: { name: string; base: string; size: string; path: string }[];
        };
        const loadPromise = client.call<LoadResult>("debug.load", {
          executablePath,
          commandLineArgs: commandLineArgs ?? "",
          breakOnEntry,
          autoAnalyze,
        });

        let outcome: { timedOut: false; val: LoadResult } | { timedOut: true };
        try {
          outcome = await Promise.race([
            loadPromise.then((val) => ({ timedOut: false as const, val })),
            new Promise<{ timedOut: true }>((r) =>
              setTimeout(() => r({ timedOut: true }), LIFECYCLE_TIMEOUT_MS)
            ),
          ]);
        } catch (err) {
          await sessions.terminate(session.id);
          throw err;
        }

        if (outcome.timedOut) {
          const s = sessions.peek(session.id);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                timedOut: true,
                sessionId: session.id,
                state: s.state,
                pauseReason: s.pauseReason,
                terminationReason: s.terminationReason,
                recentEvents: [...s.recentEvents],
              }, null, 2),
            }],
          };
        }

        // 7. Success — update pid from bridge response, peek state (set by push events).
        const result = outcome.val;
        sessions.updatePid(session.id, result.pid);
        const s = sessions.peek(session.id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              timedOut: false,
              sessionId: session.id,
              pid: result.pid,
              architecture: result.architecture || arch,
              entryPoint: result.entryPoint,
              state: s.state,
              pauseReason: s.pauseReason,
              terminationReason: s.terminationReason,
              recentEvents: [...s.recentEvents],
              modulesLoaded: result.modules.length,
              bridgePort: port,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`load_executable failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Attach to running process ─────────────────────────────────────────

  server.tool(
    "attach_to_process",
    "Attach to an already-running process by PID. " +
      "Returns { timedOut, sessionId, state, pauseReason, terminationReason, recentEvents, pid, architecture, ... }. " +
      "Waits until the post-attach system BP fires (state:'paused', pauseReason:'system_breakpoint'). " +
      "Implicit 60 s safety timeout: on timeout returns timedOut:true with state:'loading'. " +
      "Auto-detects x86/x64 process architecture. " +
      "Read recentEvents for the full attach trail.",
    {
      pid: z.number().int().positive().describe("Process ID to attach to"),
      breakOnEntry: z
        .boolean()
        .default(true)
        .describe("Pause execution immediately after attach (default true)"),
      autoAnalyze: z
        .boolean()
        .default(true)
        .describe("Run analysis on attach (default true)"),
    },
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

        // 5. D13 — create session in "loading" state, wire events, then fire debug.attach.
        const session = sessions.createLoading(`<attached-pid-${pid}>`, targetArch, port);
        sessions.updatePid(session.id, pid);
        bridges.set(session.id, client);
        rememberDebuggerForSession(session.id, child);
        sessions.wireClient(session.id, client);

        // 6. Fire debug.attach with implicit 60 s safety timeout.
        const LIFECYCLE_TIMEOUT_MS = 60_000;
        type AttachResult = {
          pid: number;
          architecture: string;
          entryPoint: string;
          modules: Array<{ name: string; base: string; size: number }>;
        };
        const attachPromise = client.call<AttachResult>("debug.attach", {
          sessionId: session.id,
          pid,
          breakOnEntry,
          autoAnalyze,
        });

        let outcome: { timedOut: false; val: AttachResult } | { timedOut: true };
        try {
          outcome = await Promise.race([
            attachPromise.then((val) => ({ timedOut: false as const, val })),
            new Promise<{ timedOut: true }>((r) =>
              setTimeout(() => r({ timedOut: true }), LIFECYCLE_TIMEOUT_MS)
            ),
          ]);
        } catch (err) {
          await sessions.terminate(session.id);
          throw err;
        }

        if (outcome.timedOut) {
          const s = sessions.peek(session.id);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                timedOut: true,
                sessionId: session.id,
                state: s.state,
                pauseReason: s.pauseReason,
                terminationReason: s.terminationReason,
                recentEvents: [...s.recentEvents],
              }, null, 2),
            }],
          };
        }

        const result = outcome.val;
        const s = sessions.peek(session.id);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              timedOut: false,
              sessionId: session.id,
              pid: result.pid,
              architecture: result.architecture,
              entryPoint: result.entryPoint,
              state: s.state,
              pauseReason: s.pauseReason,
              terminationReason: s.terminationReason,
              recentEvents: [...s.recentEvents],
              modulesLoaded: result.modules.length,
              bridgePort: port,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`attach_to_process failed: ${msg}`);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Continue execution ────────────────────────────────────────────────

  server.tool(
    "continue_execution",
    "Resume execution of a paused debuggee. Runs until the next breakpoint, exception, or exit. " +
      "REQUIRES: session state must be 'paused'. " +
      "Returns { timedOut, state, pauseReason, terminationReason }. " +
      "With async:false (default) waits until paused again or timeout. " +
      "With async:true returns immediately — pair with wait_for_state to observe the next stop.",
    {
      sessionId: z.string().describe("Session ID from load_executable"),
      async: z.boolean().optional().default(false).describe(
        "Return immediately without waiting for the next pause (default false)"
      ),
      timeoutMs: z.number().int().min(0).max(300_000).optional().default(30_000).describe(
        "Sync-mode wait timeout in ms (default 30 000)"
      ),
    },
    async ({ sessionId, async: isAsync, timeoutMs }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        return await execEnvelope(sessionId, "debug.continue", { sessionId }, { async: isAsync, timeoutMs }, "running");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Pause execution ───────────────────────────────────────────────────

  server.tool(
    "pause_execution",
    "Pause a running debuggee. If already paused, returns immediately (no-op). " +
      "Returns { timedOut, state, pauseReason, terminationReason }. " +
      "With async:false (default) waits until paused or timeout. " +
      "With async:true issues the break and returns immediately.",
    {
      sessionId: z.string().describe("Session ID from load_executable"),
      async: z.boolean().optional().default(false).describe(
        "Return immediately after issuing pause without waiting (default false)"
      ),
      timeoutMs: z.number().int().min(0).max(300_000).optional().default(30_000).describe(
        "Sync-mode wait timeout in ms (default 30 000)"
      ),
    },
    async ({ sessionId, async: isAsync, timeoutMs }) => {
      try {
        const session = sessions.peek(sessionId);
        if (session.state === "terminated") {
          return {
            content: [{ type: "text" as const, text: `Error: E_SESSION_TERMINATED: session ${sessionId}` }],
            isError: true,
          };
        }
        // No-op: already paused
        if (session.state === "paused") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              timedOut: false, state: session.state, pauseReason: session.pauseReason,
              terminationReason: session.terminationReason,
            }, null, 2) }],
          };
        }
        return await execEnvelope(sessionId, "debug.pause", { sessionId }, { async: isAsync, timeoutMs });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Step into ─────────────────────────────────────────────────────────

  server.tool(
    "step_into",
    "Execute one or more instructions, stepping INTO function calls. " +
      "REQUIRES: session state must be 'paused'. " +
      "Returns { timedOut, state, pauseReason, terminationReason }. " +
      "Use step_over instead if you want to skip over CALL instructions.",
    {
      sessionId: z.string().describe("Session ID"),
      count: z.number().int().min(1).max(1000).default(1).describe("Instructions to step (default 1)"),
      async: z.boolean().optional().default(false).describe("Return immediately without waiting for next pause (default false)"),
      timeoutMs: z.number().int().min(0).max(300_000).optional().default(30_000).describe("Sync-mode wait timeout in ms (default 30 000)"),
    },
    async ({ sessionId, count, async: isAsync, timeoutMs }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        return await execEnvelope(sessionId, "debug.stepInto", { sessionId, count }, { async: isAsync, timeoutMs });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Step over ─────────────────────────────────────────────────────────

  server.tool(
    "step_over",
    "Execute one or more instructions, stepping OVER function calls. " +
      "REQUIRES: session state must be 'paused'. " +
      "Returns { timedOut, state, pauseReason, terminationReason }. " +
      "Use step_into if you want to trace inside the called function.",
    {
      sessionId: z.string().describe("Session ID"),
      count: z.number().int().min(1).max(1000).default(1).describe("Instructions to step (default 1)"),
      async: z.boolean().optional().default(false).describe("Return immediately without waiting for next pause (default false)"),
      timeoutMs: z.number().int().min(0).max(300_000).optional().default(30_000).describe("Sync-mode wait timeout in ms (default 30 000)"),
    },
    async ({ sessionId, count, async: isAsync, timeoutMs }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        return await execEnvelope(sessionId, "debug.stepOver", { sessionId, count }, { async: isAsync, timeoutMs });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Step out (run until return) ───────────────────────────────────────

  server.tool(
    "step_out",
    "Run until the current function returns (execute until RET). " +
      "REQUIRES: session state must be 'paused'. " +
      "Returns { timedOut, state, pauseReason, terminationReason }.",
    {
      sessionId: z.string().describe("Session ID"),
      async: z.boolean().optional().default(false).describe("Return immediately without waiting for next pause (default false)"),
      timeoutMs: z.number().int().min(0).max(300_000).optional().default(30_000).describe("Sync-mode wait timeout in ms (default 30 000)"),
    },
    async ({ sessionId, async: isAsync, timeoutMs }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        return await execEnvelope(sessionId, "debug.stepOut", { sessionId }, { async: isAsync, timeoutMs });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Terminate session ─────────────────────────────────────────────────

  server.tool(
    "terminate_session",
    "Stop the debuggee process and close the debugging session. " +
      "Idempotent: if already terminated, returns success and preserves terminationReason. " +
      "Returns { status, sessionId, terminationReason }.",
    {
      sessionId: z.string().describe("Session ID to terminate"),
    },
    async ({ sessionId }) => {
      try {
        if (!sessions.has(sessionId)) {
          return {
            content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
            isError: true,
          };
        }
        // D14 — idempotency: if already terminated, return success and preserve terminationReason
        const existing = sessions.peek(sessionId);
        if (existing.state === "terminated") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "terminated", sessionId,
                terminationReason: existing.terminationReason,
              }, null, 2),
            }],
          };
        }

        // D14 — track partial cleanup failures to downgrade terminationReason
        let partialFailure = false;
        if (bridges.has(sessionId)) {
          const b = bridgeFor(sessionId);
          if (b.isConnected) {
            try {
              await b.call("debug.stop", { sessionId });
            } catch (err) {
              logger.warn(`debug.stop failed (partial failure): ${err}`);
              partialFailure = true;
            }
          }
        }
        await sessions.terminate(sessionId);
        if (partialFailure) {
          try {
            sessions.applyStateChange(sessionId, {
              state: "terminated",
              pauseReason: null,
              terminationReason: "unknown",
            });
          } catch { /* session may already be reaped */ }
        }

        const finalState = (() => {
          try { return sessions.peek(sessionId); } catch { return null; }
        })();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "terminated", sessionId,
              terminationReason: finalState?.terminationReason ?? null,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Detach session ────────────────────────────────────────────────────

  server.tool(
    "detach_session",
    "Detach the debugger from the current debuggee without terminating the target process. " +
      "Idempotent: if already terminated/detached, returns success and preserves terminationReason. " +
      "Returns { status, sessionId, terminationReason }.",
    {
      sessionId: z.string().describe("Session ID to detach"),
    },
    async ({ sessionId }) => {
      try {
        if (!sessions.has(sessionId)) {
          return {
            content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
            isError: true,
          };
        }
        // D14 — idempotency: if already terminated, return success and preserve terminationReason
        const existing = sessions.peek(sessionId);
        if (existing.state === "terminated") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                status: "detached", sessionId,
                terminationReason: existing.terminationReason,
              }, null, 2),
            }],
          };
        }

        // D14 — partial failure tracking
        let partialFailure = false;
        let b: BridgeClient | null = null;
        try { b = bridgeFor(sessionId); } catch { /* no bridge */ }
        if (b && b.isConnected) {
          try {
            await b.call("debug.detach", { sessionId });
          } catch (err) {
            logger.warn(`debug.detach failed (partial failure): ${err}`);
            partialFailure = true;
          }
        } else if (!b || !b.isConnected) {
          // Bridge already gone — treat as partial failure
          partialFailure = true;
        }

        await sessions.terminate(sessionId);
        if (partialFailure) {
          try {
            sessions.applyStateChange(sessionId, {
              state: "terminated",
              pauseReason: null,
              terminationReason: "unknown",
            });
          } catch { /* session may already be reaped */ }
        }

        const finalState = (() => {
          try { return sessions.peek(sessionId); } catch { return null; }
        })();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              status: "detached", sessionId,
              terminationReason: finalState?.terminationReason ?? null,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get status (current debugger + session state) ─────────────────────

  server.tool(
    "get_status",
    "Query the current state of the debugger and active session. " +
      "Returns bridge connectivity, session state (idle/paused/running/stepping/terminated), " +
      "current instruction pointer, active thread, and a next-step hint. " +
      "Call this whenever you are unsure what state the debugger is in " +
      "before issuing step/continue/breakpoint operations. " +
      "This is always safe to call — it does not change any debugger state.",
    {
      sessionId: z
        .string()
        .optional()
        .describe("Session ID (optional — omit to get bridge-level status only)"),
    },
    async ({ sessionId }) => {
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

          if (b && b.isConnected && s.state === "paused") {
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
              : s.state === "loading"
              ? "Session is initializing the debuggee. Call wait_for_state(expect=\"paused\") or get_status to track progress."
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

      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
      };
    }
  );

  // ── List sessions ─────────────────────────────────────────────────────

  server.tool(
    "list_sessions",
    "List all active debugging sessions with their state and metadata.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(sessions.toJSON(), null, 2),
          },
        ],
      };
    }
  );

  // ── Close debugger process ────────────────────────────────────────────

  server.tool(
    "close_debugger",
    "Kill the x64dbg or x32dbg process. Works even if the bridge is not connected. " +
      "Use this to cleanly shut down the debugger before deploying updated plugins or " +
      "when you need to restart the debugger.",
    {
      force: z
        .boolean()
        .optional()
        .default(false)
        .describe("Force-kill via taskkill even if the process was not launched by this MCP server (default false)"),
    },
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
  );

  // ── Collect breakpoint arguments in a loop ───────────────────────────

  server.tool(
    "collect_bp_args",
    "Continue execution in a loop, collecting a memory expression at each breakpoint hit. " +
      "Use this to trace repeated calls (e.g. AddMoudle, GetClassObject). " +
      "The default expr 'ptr_utf16@[esp+4]' reads a wchar_t* arg from the x86 stack.",
    {
      sessionId: z.string().describe("Session ID"),
      expr: z.string().optional().describe(
        "Expression to read at each hit: 'ptr_utf16@[esp+4]' (default), 'utf16@<addr>', or any numeric x64dbg expr"
      ),
      maxHits: z.number().optional().describe("Stop after this many hits (default 200)"),
      timeoutSec: z.number().optional().describe("Per-hit timeout in seconds (default 10)"),
    },
    async ({ sessionId, expr, maxHits, timeoutSec }) => {
      try {
        const result = await bridgeFor(sessionId).call<{ totalHits: number; args: string[]; errors: string[] }>(
          "debug.collectBreakpointArgs",
          { sessionId, expr, maxHits, timeoutSec },
          (maxHits ?? 200) * ((timeoutSec ?? 10) + 2) * 1000
        );
        const lines = result.args.map((a, i) => `${i + 1}. ${a}`);
        if (result.errors.length) lines.push("", "Errors:", ...result.errors);
        lines.push("", `Total: ${result.totalHits} hits`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Execute raw x64dbg command ────────────────────────────────────────

  server.tool(
    "execute_command",
    "Execute a raw x64dbg command. Breakpoints: bp <addr> (sw), bph <addr>,x (hw-exec), " +
      "bpm <addr> (mem-write), bpcond <addr>, <expr> (conditional), bpc <addr> (remove). " +
      "Run-to: bp $temp_<addr>, run (one-shot). " +
      "Registers: r <reg>=<value> (set), r (view all). " +
      "Tracing: tc <expr> (trace-over until), tic <expr> (trace-into until). " +
      "Threads: switchthread <id>. " +
      "Docs: help.x64dbg.com/commands",
    {
      sessionId: z.string().describe("Session ID"),
      command: z.string().describe("x64dbg command, e.g. 'graph 0x401000' or 'findall 0, \"MZ\"'"),
    },
    async ({ sessionId, command }) => {
      try {
        const result = await bridgeFor(sessionId).call<{ output: string }>(
          "debug.executeCommand",
          { sessionId, command }
        );

        return {
          content: [{ type: "text" as const, text: result.output }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
