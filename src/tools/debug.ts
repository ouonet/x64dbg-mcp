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
import type { DebugState, PauseReason, TerminationReason } from "../types.js";

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
    "START HERE. Load a PE executable (.exe or .dll) and create a debugging session. " +
      "Auto-detects x86/x64 and launches x32dbg or x64dbg accordingly. " +
      "Returns: sessionId, pid, architecture, entryPoint, state, pauseReason, recentEvents (DLL loads, TLS callbacks, exceptions up to first pause), modulesLoaded, bridgePort.\n\n" +
      "NORMAL FLOW (breakOnEntry=true, default):\n" +
      "  1. Tool returns state='paused', pauseReason='system_breakpoint'.\n" +
      "     system_breakpoint = Windows loader debug break — fires before any user code, always happens, not an error.\n" +
      "     Action: call continue_execution(sessionId) to proceed past it.\n" +
      "  2. Execution pauses again: state='paused', pauseReason='breakpoint' at entryPoint.\n" +
      "     Now at the PE entry point. Call disassemble(sessionId, entryPoint) or continue_execution to run further.\n" +
      "  You may see pauseReason='tls_callback' between steps 1 and 2 — call continue_execution through each.\n\n" +
      "timedOut=true: process did not pause within 60 s. Check recentEvents for clues (missing DLL, anti-debug). " +
      "Call wait_for_state(expect='paused') to keep waiting, or terminate_session to abort.",
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
        const activeSessions = sessions.list().filter((s) => s.state !== "terminated");
        if (activeSessions.length >= config.maxSessions) {
          const active = activeSessions.map((s) =>
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

        // 4. Connect a fresh BridgeClient to the new x64dbg.
        //    Register the 'ready' handler BEFORE connect() so it fires correctly —
        //    'ready' is emitted inside connect() before the Promise resolves.
        const client = new BridgeClient(config.bridgeHost, port);

        // 5. Create session in "idle" state and wire push events before connecting,
        //    so stateChange / debugEvent pushes are captured from the first packet.
        const session = sessions.createIdle(executablePath, arch, port);
        bridges.set(session.id, client);
        rememberDebuggerForSession(session.id, child);
        sessions.wireClient(session.id, client);

        // Fetch bridge's actual state once the probe handshake succeeds.
        client.once("ready", () => {
          void (async () => {
            try {
              type StateResult = {
                state: "idle" | "paused" | "running" | "loading" | "terminated";
                pauseReason: string | null;
                terminationReason: string | null;
              };
              const state = await client.call<StateResult>("debug.getState", {}, 5_000);
              sessions.applyStateChange(session.id, {
                state: (state.state as DebugState) ?? "idle",
                pauseReason: (state.pauseReason as PauseReason | null) ?? null,
                terminationReason: (state.terminationReason as TerminationReason | null) ?? null,
              });
              logger.info(`Session ${session.id}: initial state = ${state.state}`);
            } catch (err) {
              logger.warn(`Session ${session.id}: debug.getState failed: ${err}`);
            }
          })();
        });

        try {
          await client.connect();
        } catch (err) {
          try { child.kill(); } catch { /* ignore */ }
          await sessions.terminate(session.id, "unknown");
          throw new Error(`Bridge connect failed on port ${port}: ${err}`);
        }

        // Transition idle → loading just before debug.load fires.
        sessions.applyStateChange(session.id, { state: "loading", pauseReason: null, terminationReason: null });

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
          const diagnostic = {
            timedOut: true,
            sessionId: session.id,
            state: s.state,
            pauseReason: s.pauseReason,
            terminationReason: s.terminationReason,
            recentEvents: [...s.recentEvents],
            note: s.state === "loading" || s.state === "idle"
              ? "Debuggee did not pause within 60s. Possible causes: (1) executable is heavily packed/obfuscated " +
                "(prevent debugger from pausing); (2) anti-debug detection failed to bypass; (3) bridge plugin failed to initialize. " +
                "Check recentEvents for DLL loads/exceptions. Use wait_for_state to continue waiting, or terminate_session to clean up."
              : `Debuggee transitioned to ${s.state} but bridge response timed out (network issue?).`,
          };
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(diagnostic, null, 2),
            }],
          };
        }

        // Wait for state to transition from "loading" to final state (paused/running/idle).
        // The bridge.ready event + debug.load push frames should have updated it by now.
        await sessions.waitForStateChange(session.id, 10_000).catch(() => {
          logger.warn(`load_executable: state change notification did not arrive within 10s`);
        });

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
    "Attach to a running process by PID and create a debugging session. " +
      "Auto-detects x86/x64 architecture. " +
      "Returns: sessionId, pid, architecture, entryPoint, state, pauseReason, recentEvents, modulesLoaded, bridgePort.\n\n" +
      "NORMAL FLOW (breakOnEntry=true, default):\n" +
      "  1. Tool returns state='paused', pauseReason='system_breakpoint'.\n" +
      "     Windows injects a debug break on attach — this is normal, not a crash.\n" +
      "     Action: call continue_execution(sessionId) to resume the process.\n" +
      "  2. Process runs. To stop at a specific point: use execute_command to set a breakpoint " +
      "     (e.g. 'bp 0x401000'), then continue_execution; or call pause_execution(sessionId) to " +
      "     halt at the current instruction.\n\n" +
      "timedOut=true: attach did not complete within 60 s. Call terminate_session to clean up.",
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
        const activeSessions = sessions.list().filter((s) => s.state !== "terminated");
        if (activeSessions.length >= config.maxSessions) {
          const active = activeSessions.map((s) =>
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

        // 4. Create session in "idle" state and wire events BEFORE connecting,
        //    so push events from the first packet are captured.
        const client = new BridgeClient(config.bridgeHost, port);
        const session = sessions.createIdle(`<attached-pid-${pid}>`, targetArch, port);
        sessions.updatePid(session.id, pid);
        bridges.set(session.id, client);
        rememberDebuggerForSession(session.id, child);
        sessions.wireClient(session.id, client);

        // Fetch bridge state once probe handshake succeeds (registered before connect).
        client.once("ready", () => {
          void (async () => {
            try {
              type StateResult = {
                state: "idle" | "paused" | "running" | "loading" | "terminated";
                pauseReason: string | null;
                terminationReason: string | null;
              };
              const state = await client.call<StateResult>("debug.getState", {}, 5_000);
              sessions.applyStateChange(session.id, {
                state: (state.state as DebugState) ?? "idle",
                pauseReason: (state.pauseReason as PauseReason | null) ?? null,
                terminationReason: (state.terminationReason as TerminationReason | null) ?? null,
              });
              logger.info(`Session ${session.id}: initial state = ${state.state}`);
            } catch (err) {
              logger.warn(`Session ${session.id}: debug.getState failed: ${err}`);
            }
          })();
        });

        try {
          await client.connect();
        } catch (err) {
          try { child.kill(); } catch { /* ignore */ }
          await sessions.terminate(session.id, "unknown");
          throw err;
        }

        // Transition idle → loading just before debug.attach fires.
        sessions.applyStateChange(session.id, { state: "loading", pauseReason: null, terminationReason: null });

        // 5. Fire debug.attach with implicit 60 s safety timeout.
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
          await sessions.terminate(session.id, "unknown");
          throw err;
        }

        if (outcome.timedOut) {
          const s = sessions.peek(session.id);
          const diagnostic = {
            timedOut: true,
            sessionId: session.id,
            state: s.state,
            pauseReason: s.pauseReason,
            terminationReason: s.terminationReason,
            recentEvents: [...s.recentEvents],
            note: s.state === "loading" || s.state === "idle"
              ? "Attached process did not pause within 60s. Check recentEvents for DLL loads/exceptions. " +
                "Use wait_for_state to continue waiting, or terminate_session to clean up."
              : `Process transitioned to ${s.state} but bridge response timed out (network issue?).`,
          };
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(diagnostic, null, 2),
            }],
          };
        }

        // Wait for state to transition from "loading" to final state.
        // The bridge.ready event + debug.attach push frames should have updated it by now.
        await sessions.waitForStateChange(session.id, 10_000).catch(() => {
          logger.warn(`attach_to_process: state change notification did not arrive within 10s`);
        });

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
    "Resume a paused debuggee. Runs until the next breakpoint, exception, manual pause, or process exit. " +
      "REQUIRES: state='paused'. Call get_status(sessionId) if unsure of current state. " +
      "Returns: { timedOut, state, pauseReason, terminationReason }.\n\n" +
      "pauseReason in the response tells you why execution stopped:\n" +
      "  'breakpoint'        → software/hardware/memory BP hit; inspect with get_registers, disassemble\n" +
      "  'system_breakpoint' → Windows loader break; call continue_execution again to proceed\n" +
      "  'exception'         → first-chance exception; inspect with get_registers, disassemble\n" +
      "  'manual_pause'      → pause_execution was called\n" +
      "  'tls_callback'      → TLS callback entry; call continue_execution to skip\n" +
      "  'trace_terminated'  → a tc/tic trace command completed\n" +
      "  null + state='terminated' → process exited; check terminationReason\n\n" +
      "async:true: returns immediately with current snapshot; pair with wait_for_state(expect='paused') to observe the next stop. " +
      "timedOut:true (sync): process still running after timeoutMs; call wait_for_state or terminate_session.",
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
    "Interrupt a running debuggee. No-op if already paused — returns current state immediately. " +
      "Returns: { timedOut, state, pauseReason='manual_pause', terminationReason }. " +
      "If state is unknown, call get_status(sessionId) first — it is always safe. " +
      "async:true: issues the break and returns immediately without waiting for confirmation.",
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
    "Single-step N instructions, following CALL instructions into callees. " +
      "REQUIRES: state='paused'. Returns: { timedOut, state, pauseReason='step', terminationReason }. " +
      "After each step the session pauses again with pauseReason='step'. " +
      "Use step_over to skip over CALL instructions instead of entering them.",
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
    "Single-step N instructions, treating each CALL as a single step (does not enter callees). " +
      "REQUIRES: state='paused'. Returns: { timedOut, state, pauseReason='step', terminationReason }. " +
      "Use step_into to trace inside called functions.",
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
    "Run until the current function returns (executes to its matching RET instruction). " +
      "REQUIRES: state='paused'. Returns: { timedOut, state, pauseReason, terminationReason }. " +
      "Useful to escape deep call chains and return to a higher-level function.",
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
      "Idempotent — safe to call even if the session is already terminated. " +
      "Returns: { status='terminated', sessionId, terminationReason }. " +
      "terminationReason values: 'process_exit', 'detached', 'bridge_lost', 'unknown'. " +
      "Call this to free a session slot when MAX_SESSIONS is reached.",
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
    "Detach the debugger from the process without killing it — the target process continues running. " +
      "Idempotent — safe to call if already terminated or detached. " +
      "Returns: { status='detached', sessionId, terminationReason }. " +
      "Use this instead of terminate_session when you want to leave the target alive after analysis.",
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

  // ── Wait for state ────────────────────────────────────────────────────

  server.tool(
    "wait_for_state",
    "Block until the session reaches a target state, then return a full snapshot. " +
      "Returns: { matched, state, pauseReason, terminationReason, lastEvent, recentEvents }. " +
      "matched=true: condition met within timeoutMs. matched=false: timed out.\n\n" +
      "Common patterns:\n" +
      "  wait_for_state(expect='paused')                                   — wait for any pause\n" +
      "  wait_for_state(expect='paused', pauseReasonFilter=['breakpoint'])  — wait only for a BP hit\n" +
      "  wait_for_state(expect='terminated')                               — wait for process to exit\n\n" +
      "Use after continue_execution(async:true) or load_executable to observe the next stop. " +
      "pauseReasonFilter=[]: special case — never matches (waits until timeout); only use intentionally.",
    {
      sessionId: z.string().describe("Session ID"),
      expect: z
        .enum(["idle", "paused", "running", "terminated"])
        .describe("Target state to wait for"),
      timeoutMs: z
        .number().int().min(0).max(300_000).optional().default(30_000)
        .describe("Maximum wait time in ms (default 30 000)"),
      pauseReasonFilter: z
        .array(z.string()).optional()
        .describe("Only wake when pauseReason is one of these values (undefined = any reason; [] = never match)"),
      terminationReasonFilter: z
        .array(z.string()).optional()
        .describe("Only wake when terminationReason is one of these values (undefined = any; [] = never match)"),
    },
    async ({ sessionId, expect, timeoutMs, pauseReasonFilter, terminationReasonFilter }) => {
      try {
        if (!sessions.has(sessionId)) {
          return {
            content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
            isError: true,
          };
        }

        function conditionMatches(): boolean {
          const s = sessions.peek(sessionId);
          if (s.state !== expect) return false;
          if (expect === "paused" && pauseReasonFilter !== undefined) {
            if (pauseReasonFilter.length === 0) return false;
            if (!pauseReasonFilter.includes(s.pauseReason as string)) return false;
          }
          if (expect === "terminated" && terminationReasonFilter !== undefined) {
            if (terminationReasonFilter.length === 0) return false;
            if (!terminationReasonFilter.includes(s.terminationReason as string)) return false;
          }
          return true;
        }

        function stateSnapshot() {
          const s = sessions.peek(sessionId);
          return {
            state: s.state,
            pauseReason: s.pauseReason,
            terminationReason: s.terminationReason,
            lastEvent: s.lastEvent,
            recentEvents: s.recentEvents,
          };
        }

        const deadline = Date.now() + timeoutMs;

        while (true) {
          if (conditionMatches()) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(
                { matched: true, ...stateSnapshot() }, null, 2,
              ) }],
            };
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(
                { matched: false, ...stateSnapshot() }, null, 2,
              ) }],
            };
          }
          const woken = await sessions.waitForStateChange(sessionId, remaining);
          if (!woken) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(
                { matched: false, ...stateSnapshot() }, null, 2,
              ) }],
            };
          }
          // State changed — loop to re-check condition
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get status (current debugger + session state) ─────────────────────

  server.tool(
    "get_status",
    "Query the current session/debugger state. Always safe — never changes debugger state. " +
      "Returns: state, pauseReason, terminationReason, lastEvent, recentEvents, currentIP (when paused), " +
      "bridgeConnected, breakpointCount, executable, pid, architecture, and a hint describing recommended next action.\n\n" +
      "Call this:\n" +
      "  • Before step_into/step_over/continue when unsure if the session is paused\n" +
      "  • After a timeout to understand what state execution reached\n" +
      "  • Any time to get the current instruction pointer without reading registers\n\n" +
      "Without sessionId: returns a summary of all active sessions plus a hint to call load_executable.",
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
            pauseReason: s.pauseReason,
            terminationReason: s.terminationReason,
            lastEvent: s.lastEvent,
            recentEvents: s.recentEvents,
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
            s.state === "idle"
              ? "Debugger is ready, no debuggee loaded. Call load_executable or attach_to_process to start debugging."
              : s.state === "loading"
              ? "Debuggee is being loaded. Call wait_for_state(expect=\"paused\") to block until ready."
              : s.state === "paused"
              ? "Debuggee is paused. You may call: step_into, step_over, step_out, continue_execution, get_registers, disassemble, read_memory."
              : s.state === "running"
              ? "Debuggee is running. Wait for it to pause at a breakpoint, or call terminate_session."
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
    "List all active debugging sessions: id, state, pid, architecture, executable, breakpointCount. " +
      "Call get_status(sessionId) for detailed state of a specific session.",
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
    "Terminate all sessions and kill all tracked x64dbg/x32dbg processes. " +
      "Works even when the bridge is disconnected. " +
      "Use before deploying updated plugins or when restarting the debugger is needed. " +
      "force=true: also kills any x64dbg.exe/x32dbg.exe not launched by this server via taskkill.",
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
    "Loop: continue execution → hit breakpoint → read a memory expression → repeat N times. " +
      "Collects the expression value at each hit, returning all values as a list. " +
      "Use to trace repeated calls — e.g. set a BP on CreateFileW with execute_command, " +
      "then call collect_bp_args(expr='utf16@[esp+8]') to log every filename opened. " +
      "Default expr 'ptr_utf16@[esp+4]' reads a wchar_t* from x86 stack offset +4. " +
      "Returns: { totalHits, args: string[], errors: string[] }. " +
      "Prerequisite: session must be paused with at least one breakpoint already set.",
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
    "Execute a raw x64dbg script command synchronously and return its console output. " +
      "Commands that resume execution (run, go, erun) do NOT wait for the next pause — " +
      "follow with wait_for_state(expect='paused') to observe the result.\n\n" +
      "Key commands:\n" +
      "  Breakpoints: bp <addr>           — software BP\n" +
      "               bph <addr>,x        — hardware exec BP\n" +
      "               bpm <addr>          — memory write BP\n" +
      "               bpcond <addr>,<e>   — conditional BP (e.g. 'bpcond 0x401000, eax==1')\n" +
      "               bpc <addr>          — remove BP\n" +
      "               bl                  — list all BPs\n" +
      "  Run-to addr: bp $<lbl>; run      — set one-shot BP then run\n" +
      "  Registers:   r <reg>=<val>       — set register (e.g. 'r eax=0')\n" +
      "               r                   — view all registers\n" +
      "  Tracing:     tc <expr>           — trace-over until expression true\n" +
      "               tic <expr>          — trace-into until expression true\n" +
      "  Threads:     switchthread <id>   — switch active thread\n" +
      "  Analysis:    analyse             — re-analyze current module\n" +
      "  Misc:        graph <addr>        — show CFG; findall 0,\"MZ\" — search\n" +
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
