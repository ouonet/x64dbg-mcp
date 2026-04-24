/**
 * Memory and register inspection tools
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridge } from "../bridge.js";
import { sessions } from "../session.js";
import { config } from "../config.js";
import type { StackFrame, ThreadInfo, MemoryRegion } from "../types.js";

export function registerMemoryTools(server: McpServer): void {
  // ── Read memory ───────────────────────────────────────────────────────

  server.tool(
    "read_memory",
    "Read raw bytes from the debuggee's virtual address space. " +
      "Returns a hex+ASCII dump. Address must be in the debuggee's mapped memory " +
      "(see get_memory_map for valid ranges). " +
      "REQUIRES: session must be paused.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Start address (hex, e.g. '0x00401000')"),
      size: z
        .number()
        .int()
        .min(1)
        .max(0x10000)
        .default(256)
        .describe("Number of bytes to read (max 65536, default 256)"),
    },
    async ({ sessionId, address, size }) => {
      try {
        sessions.get(sessionId); // validate session

        const result = await bridge.call<{
          address: string;
          size: number;
          hex: string;
          ascii: string;
          hexDump: string;
        }>("memory.read", { sessionId, address, size });

        return {
          content: [{ type: "text" as const, text: result.hexDump }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Write memory ──────────────────────────────────────────────────────

  server.tool(
    "write_memory",
    "Write bytes to the debuggee's virtual memory. Use with caution — " +
      "writing to wrong addresses can crash the debuggee.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Target address (hex)"),
      hexBytes: z
        .string()
        .describe("Hex string of bytes to write, e.g. '90 90 90' for three NOPs"),
    },
    async ({ sessionId, address, hexBytes }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          address: string;
          bytesWritten: number;
        }>("memory.write", { sessionId, address, hexBytes });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "written", address: result.address, bytesWritten: result.bytesWritten },
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

  // ── Search memory ─────────────────────────────────────────────────────

  server.tool(
    "search_memory",
    "Search the debuggee's memory for a byte pattern or string. " +
      "Supports hex patterns with wildcards (e.g. '4D 5A ?? ??') and text strings.",
    {
      sessionId: z.string().describe("Session ID"),
      pattern: z
        .string()
        .describe("Hex pattern with optional ?? wildcards, or a text string"),
      searchType: z
        .enum(["hex", "ascii", "unicode"])
        .default("hex")
        .describe("Pattern interpretation: hex bytes, ASCII text, or Unicode text"),
      startAddress: z
        .string()
        .optional()
        .describe("Start address (default: image base)"),
      endAddress: z
        .string()
        .optional()
        .describe("End address (default: end of image)"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(100)
        .describe("Maximum number of results (default 100)"),
    },
    async ({ sessionId, pattern, searchType, startAddress, endAddress, maxResults }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          matches: { address: string; context: string }[];
          totalFound: number;
          truncated: boolean;
        }>("memory.search", {
          sessionId,
          pattern,
          searchType,
          startAddress,
          endAddress,
          maxResults: Math.min(maxResults, config.maxSearchResults),
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  totalFound: result.totalFound,
                  returned: result.matches.length,
                  truncated: result.truncated,
                  matches: result.matches,
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

  // ── Memory map ────────────────────────────────────────────────────────

  server.tool(
    "get_memory_map",
    "Return the virtual memory map of the debuggee process: " +
      "all regions with base address, size, protection, type, and associated module.",
    {
      sessionId: z.string().describe("Session ID"),
      filterModule: z
        .string()
        .optional()
        .describe("Optional module name to filter regions by"),
      filterProtection: z
        .string()
        .optional()
        .describe("Optional protection filter, e.g. 'ERW' (Execute-Read-Write)"),
    },
    async ({ sessionId, filterModule, filterProtection }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          regions: MemoryRegion[];
          totalRegions: number;
        }>("memory.map", { sessionId, filterModule, filterProtection });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get registers ─────────────────────────────────────────────────────

  server.tool(
    "get_registers",
    "Read the current CPU register values of the active thread. " +
      "Includes general-purpose registers, instruction pointer (RIP/EIP), " +
      "flags, and optionally segment and debug registers. " +
      "REQUIRES: session must be paused (call get_status to check). " +
      "On x64: returns RAX, RBX, RCX, RDX, RSI, RDI, RSP, RBP, RIP, R8-R15. " +
      "On x86: returns EAX, EBX, ECX, EDX, ESI, EDI, ESP, EBP, EIP.",
    {
      sessionId: z.string().describe("Session ID"),
      includeSegment: z
        .boolean()
        .default(false)
        .describe("Include segment registers (cs, ds, es, fs, gs, ss)"),
      includeDebug: z
        .boolean()
        .default(false)
        .describe("Include debug registers (dr0-dr7)"),
      includeFpu: z
        .boolean()
        .default(false)
        .describe("Include FPU / SSE registers"),
    },
    async ({ sessionId, includeSegment, includeDebug, includeFpu }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          general: Record<string, string>;
          flags: Record<string, boolean>;
          segment?: Record<string, string>;
          debug?: Record<string, string>;
          fpu?: Record<string, string>;
        }>("registers.get", { sessionId, includeSegment, includeDebug, includeFpu });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Set register ──────────────────────────────────────────────────────

  server.tool(
    "set_register",
    "Set the value of a single CPU register.",
    {
      sessionId: z.string().describe("Session ID"),
      register: z
        .string()
        .describe("Register name, e.g. 'rax', 'eip', 'zf'"),
      value: z
        .string()
        .describe("New value (hex for GP registers, '0'/'1' for flags)"),
    },
    async ({ sessionId, register, value }) => {
      try {
        sessions.get(sessionId);

        await bridge.call("registers.set", { sessionId, register, value });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "register_set", register, value },
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

  // ── Get call stack ────────────────────────────────────────────────────

  server.tool(
    "get_call_stack",
    "Get the call stack (backtrace) of the current thread. " +
      "Shows return addresses, module names, and function names where available.",
    {
      sessionId: z.string().describe("Session ID"),
      maxFrames: z
        .number()
        .int()
        .min(1)
        .max(256)
        .default(50)
        .describe("Maximum stack frames to return (default 50)"),
    },
    async ({ sessionId, maxFrames }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          threadId: number;
          frames: StackFrame[];
        }>("stack.getCallStack", { sessionId, maxFrames });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get threads ───────────────────────────────────────────────────────

  server.tool(
    "get_threads",
    "List all threads in the debuggee process with their current state.",
    {
      sessionId: z.string().describe("Session ID"),
    },
    async ({ sessionId }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          activeThreadId: number;
          threads: ThreadInfo[];
        }>("threads.list", { sessionId });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Switch thread ─────────────────────────────────────────────────────

  server.tool(
    "switch_thread",
    "Switch the active thread. Subsequent register/stack/step operations " +
      "will apply to this thread.",
    {
      sessionId: z.string().describe("Session ID"),
      threadId: z.number().int().describe("Thread ID to switch to"),
    },
    async ({ sessionId, threadId }) => {
      try {
        sessions.get(sessionId);

        const result = await bridge.call<{
          previousThread: number;
          currentThread: number;
          address: string;
        }>("threads.switch", { sessionId, threadId });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
