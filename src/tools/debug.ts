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

/** States in which step/continue operations make sense. */
const STEPPABLE_STATES = new Set(["paused", "idle"]);

/**
 * Assert a session exists and is in a steppable state.
 * Returns an error response object if the check fails, otherwise null.
 */
function requirePaused(
  sessionId: string
): { content: [{ type: "text"; text: string }]; isError: true } | null {
  const s = sessions.list().find((x) => x.id === sessionId);
  if (!s) {
    return {
      content: [{ type: "text" as const, text: `Error: Session not found: ${sessionId}` }],
      isError: true,
    };
  }
  if (!STEPPABLE_STATES.has(s.state)) {
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

export function registerDebugTools(server: McpServer): void {
  // ── Load executable ───────────────────────────────────────────────────

  server.tool(
    "load_executable",
    "START HERE — load a PE executable into x64dbg and create a debugging session. " +
      "Returns a sessionId that ALL other tools require as their first parameter. " +
      "Auto-detects 32-bit vs 64-bit PE and launches x32dbg or x64dbg accordingly. " +
      "With breakOnEntry=true (default): execution stops at the entry point and the " +
      "session state becomes 'paused' — you can immediately call step_into, " +
      "get_registers, or disassemble. " +
      "With breakOnEntry=false: the debuggee starts running; use set_breakpoint then " +
      "continue_execution to pause it later. " +
      "Only one session can be active at a time. Call terminate_session first if one exists.",
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
  );

  // ── Attach to running process ─────────────────────────────────────────

  server.tool(
    "attach_to_process",
    "Attach to an already-running process by PID. Auto-detects the process architecture " +
      "(x86 or x64) and launches the appropriate debugger if one is not already running. " +
      "If a debugger is already active with a different target, it will be stopped first. " +
      "With breakOnEntry=true (default): execution pauses at the current instruction. " +
      "With breakOnEntry=false: execution continues and pauses when stable state is reached. " +
      "Returns a sessionId that can be used with other debugging tools.",
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

        // 5. Register and tell bridge to attach
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
  );

  // ── Continue execution ────────────────────────────────────────────────

  server.tool(
    "continue_execution",
    "Resume execution of a paused debuggee. Runs until the next breakpoint, " +
      "exception, or program exit. " +
      "REQUIRES: session state must be 'paused' (check with get_status). " +
      "Returns stopReason ('breakpoint', 'paused', or 'exited') and the address where " +
      "execution stopped. If stopReason is 'exited', the process has terminated.",
    {
      sessionId: z.string().describe("Session ID from load_executable"),
    },
    async ({ sessionId }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        sessions.updateState(sessionId, "running");

        const result = await bridgeFor(sessionId).call<{
          reason: string;
          address: string;
          module?: string;
          exception?: string;
        }>("debug.continue", { sessionId });

        sessions.updateState(sessionId, result.reason === "exited" ? "terminated" : "paused");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  sessionId,
                  stopReason: result.reason,
                  currentAddress: result.address,
                  module: result.module,
                  exception: result.exception,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sessions.has(sessionId)) sessions.updateState(sessionId, "paused");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Pause execution ───────────────────────────────────────────────────

  server.tool(
    "pause_execution",
    "Pause a running debuggee. Issues an asynchronous break and waits for " +
      "the debuggee to actually stop. " +
      "REQUIRES: an active session (state 'running' or 'paused'). " +
      "If the session is already paused, this is a no-op and returns the current address. " +
      "Returns stopReason ('paused' or 'exited') and the address where execution stopped.",
    {
      sessionId: z.string().describe("Session ID from load_executable"),
    },
    async ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Unknown sessionId: ${sessionId}. Call load_executable first.`,
            },
          ],
          isError: true,
        };
      }
      if (session.state === "terminated") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: Session ${sessionId} has already terminated.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await bridgeFor(sessionId).call<{
          reason: string;
          address: string;
        }>("debug.pause", { sessionId });

        sessions.updateState(sessionId, result.reason === "exited" ? "terminated" : "paused");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  sessionId,
                  stopReason: result.reason,
                  currentAddress: result.address,
                },
                null,
                2
              ),
            },
          ],
        };
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
      "Returns the new address, disassembly, module, and key register values after stepping. " +
      "Use step_over instead if you want to skip over CALL instructions.",
    {
      sessionId: z.string().describe("Session ID"),
      count: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(1)
        .describe("Number of instructions to step (default 1)"),
    },
    async ({ sessionId, count }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        sessions.updateState(sessionId, "stepping");

        const result = await bridgeFor(sessionId).call<{
          address: string;
          disassembly: string;
          module?: string;
          function?: string;
          registers: Record<string, string>;
        }>("debug.stepInto", { sessionId, count });

        sessions.updateState(sessionId, "paused");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sessions.has(sessionId)) sessions.updateState(sessionId, "paused");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Step over ─────────────────────────────────────────────────────────

  server.tool(
    "step_over",
    "Execute one or more instructions, stepping OVER function calls. " +
      "REQUIRES: session state must be 'paused'. " +
      "If the current instruction is a CALL, the entire called function executes " +
      "and control returns to the instruction after the CALL. " +
      "Use step_into if you want to trace inside the called function.",
    {
      sessionId: z.string().describe("Session ID"),
      count: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(1)
        .describe("Number of instructions to step (default 1)"),
    },
    async ({ sessionId, count }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        sessions.updateState(sessionId, "stepping");

        const result = await bridgeFor(sessionId).call<{
          address: string;
          disassembly: string;
          module?: string;
          function?: string;
          registers: Record<string, string>;
        }>("debug.stepOver", { sessionId, count });

        sessions.updateState(sessionId, "paused");

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sessions.has(sessionId)) sessions.updateState(sessionId, "paused");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Step out (run until return) ───────────────────────────────────────

  server.tool(
    "step_out",
    "Run until the current function returns (execute until RET). " +
      "REQUIRES: session state must be 'paused'. " +
      "Useful for quickly leaving a called function and returning to the caller " +
      "without stepping through every instruction.",
    {
      sessionId: z.string().describe("Session ID"),
    },
    async ({ sessionId }) => {
      const stateErr = requirePaused(sessionId);
      if (stateErr) return stateErr;
      try {
        sessions.updateState(sessionId, "stepping");

        const result = await bridgeFor(sessionId).call<{
          address: string;
          disassembly: string;
          returnValue?: string;
          module?: string;
          function?: string;
        }>("debug.stepOut", { sessionId });

        sessions.updateState(sessionId, "paused");

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sessions.has(sessionId)) sessions.updateState(sessionId, "paused");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Run to address ────────────────────────────────────────────────────

  server.tool(
    "run_to_address",
    "Set a one-shot breakpoint at the given address and continue execution. " +
      "Stops when the address is reached or another breakpoint/exception fires first.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Target address (hex, e.g. 0x00401000) or symbol name"),
    },
    async ({ sessionId, address }) => {
      try {
        sessions.updateState(sessionId, "running");

        const result = await bridgeFor(sessionId).call<{
          reached: boolean;
          stopAddress: string;
          reason: string;
        }>("debug.runToAddress", { sessionId, address });

        sessions.updateState(sessionId, "paused");

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (sessions.has(sessionId)) sessions.updateState(sessionId, "paused");
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Set breakpoint ────────────────────────────────────────────────────

  server.tool(
    "set_breakpoint",
    "Set a breakpoint. Supports software BPs, hardware BPs (execute/read/write), " +
      "and memory BPs. Optionally supply a condition expression or log text.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z
        .string()
        .describe("Address (hex) or symbol name, e.g. '0x401000' or 'kernel32.CreateFileW'"),
      type: z
        .enum([
          "software",
          "hardware_execute",
          "hardware_read",
          "hardware_write",
          "hardware_access",
          "memory_read",
          "memory_write",
          "memory_access",
        ])
        .default("software")
        .describe("Breakpoint type (default: software)"),
      condition: z
        .string()
        .optional()
        .describe("x64dbg condition expression, e.g. 'eax==0'"),
      logText: z
        .string()
        .optional()
        .describe("Text to log when the breakpoint hits (no break)"),
      name: z.string().optional().describe("Friendly name for this breakpoint"),
    },
    async ({ sessionId, address, type, condition, logText, name }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          address: string;
          resolved: boolean;
          module?: string;
        }>("debug.setBreakpoint", {
          sessionId,
          address,
          type,
          condition,
          logText,
        });

        const bp: Breakpoint = {
          address: result.address,
          type: type as BreakpointType,
          enabled: true,
          hitCount: 0,
          condition,
          logText,
          name,
          module: result.module,
        };
        sessions.addBreakpoint(sessionId, bp);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "breakpoint_set",
                  address: result.address,
                  bpType: type,
                  resolved: result.resolved,
                  module: result.module,
                  condition: condition ?? null,
                  name: name ?? null,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Remove breakpoint ─────────────────────────────────────────────────

  server.tool(
    "remove_breakpoint",
    "Remove a previously set breakpoint at the given address.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Address of the breakpoint to remove"),
    },
    async ({ sessionId, address }) => {
      try {
        await bridgeFor(sessionId).call("debug.removeBreakpoint", { sessionId, address });
        sessions.removeBreakpoint(sessionId, address);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ status: "breakpoint_removed", address }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── List breakpoints ──────────────────────────────────────────────────

  server.tool(
    "list_breakpoints",
    "List all breakpoints in the session, including hit counts and conditions.",
    {
      sessionId: z.string().describe("Session ID"),
    },
    async ({ sessionId }) => {
      try {
        const result = await bridgeFor(sessionId).call<{
          breakpoints: Breakpoint[];
        }>("debug.listBreakpoints", { sessionId });

        // Sync local state with bridge
        const s = sessions.get(sessionId);
        s.breakpoints.clear();
        for (const bp of result.breakpoints) {
          s.breakpoints.set(bp.address, bp);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: result.breakpoints.length,
                  breakpoints: result.breakpoints,
                },
                null,
                2
              ),
            },
          ],
        };
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
      "x64dbg itself stays open and ready for the next load_executable call. " +
      "Call this before loading a new executable, or when analysis is complete.",
    {
      sessionId: z.string().describe("Session ID to terminate"),
    },
    async ({ sessionId }) => {
      try {
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
      "x64dbg itself stays open and ready for the next attach_to_process or load_executable call.",
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
        let b: BridgeClient;
        try { b = bridgeFor(sessionId); } catch {
          return {
            content: [{
              type: "text" as const,
              text: "Error: No bridge for session — cannot detach.",
            }],
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

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              { status: "detached", sessionId, processKept: true, debuggerKept: false },
              null, 2,
            ),
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
    "Execute a raw x64dbg command string. Use this for advanced operations " +
      "not covered by other tools. Returns the command output.",
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
