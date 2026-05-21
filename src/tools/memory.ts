/**
 * Memory and register inspection tools
 */

import path from "path";
import fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeFor } from "../bridgeRegistry.js";
import { sessions } from "../session.js";
import { config } from "../config.js";
import type { StackFrame, ThreadInfo, MemoryRegion } from "../types.js";

const MAX_DUMP_SIZE = 256 * 1024 * 1024; // 256 MB

/** D8 — validate outputPath: absolute, parent exists, not a directory, no trailing sep. */
function validateOutputPath(outputPath: string): string | null {
  // Must be absolute
  if (!path.isAbsolute(outputPath)) {
    return `outputPath must be an absolute path, got: ${outputPath}`;
  }
  // No trailing separator
  const normalized = path.normalize(outputPath);
  const lastChar = outputPath[outputPath.length - 1];
  if (lastChar === "/" || lastChar === "\\") {
    return `outputPath must not end with a path separator: ${outputPath}`;
  }
  // Must not point to an existing directory
  try {
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) {
      return `outputPath resolves to an existing directory: ${normalized}`;
    }
  } catch {
    // File does not exist yet — that's fine; check parent below
  }
  // Parent directory must exist
  const parent = path.dirname(normalized);
  try {
    const parentStat = fs.statSync(parent);
    if (!parentStat.isDirectory()) {
      return `Parent path is not a directory: ${parent}`;
    }
  } catch {
    return `Parent directory does not exist: ${parent}`;
  }
  return null; // valid
}

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

        const result = await bridgeFor(sessionId).call<{
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
    "Write bytes to the debuggee's virtual memory. Caution: writing to wrong addresses can crash the debuggee. " +
      "Returns address, size, and written (bytes successfully written). Address must be in valid debuggee memory.",
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

        const result = await bridgeFor(sessionId).call<{
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

        const result = await bridgeFor(sessionId).call<{
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

        const result = await bridgeFor(sessionId).call<{
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

        const result = await bridgeFor(sessionId).call<{
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

        const result = await bridgeFor(sessionId).call<{
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

        const result = await bridgeFor(sessionId).call<{
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

  // ── Save memory dump ──────────────────────────────────────────────────

  server.tool(
    "save_memory_dump",
    "Save a raw memory region from the debuggee to a file. " +
      "outputPath must be absolute, parent must exist, must not point to a directory. " +
      "File is overwritten silently if it already exists. Size cap: 256 MB. " +
      "Returns { savedTo, bytesWritten }.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Start address (hex or symbol, e.g. '0x401000', 'rip')"),
      size: z
        .number().int().min(1)
        .describe("Number of bytes to dump (max 256 MB)"),
      outputPath: z
        .string()
        .describe("Absolute path for the output file (parent must exist)"),
    },
    async ({ sessionId, address, size, outputPath }) => {
      try {
        sessions.get(sessionId);

        if (size > MAX_DUMP_SIZE) {
          return {
            content: [{ type: "text" as const, text: `Error: size ${size} exceeds 256 MB cap` }],
            isError: true,
          };
        }

        const pathErr = validateOutputPath(outputPath);
        if (pathErr) {
          return { content: [{ type: "text" as const, text: `Error: ${pathErr}` }], isError: true };
        }

        const result = await bridgeFor(sessionId).call<{ bytesWritten: number }>(
          "memory.saveDump", { sessionId, address, size, outputPath }
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              savedTo: path.resolve(outputPath),
              bytesWritten: result.bytesWritten,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Create minidump ───────────────────────────────────────────────────

  server.tool(
    "create_minidump",
    "Create a Windows minidump of the debuggee process. " +
      "outputPath must be absolute, parent must exist, must not point to a directory. " +
      "dumpType 'normal' includes threads/modules/stack; 'full' includes all process memory. " +
      "Returns { savedTo, fileSize }.",
    {
      sessionId: z.string().describe("Session ID"),
      outputPath: z
        .string()
        .describe("Absolute path for the .dmp output file (parent must exist)"),
      dumpType: z
        .enum(["normal", "full"]).optional().default("normal")
        .describe("'normal' = small (threads+modules+stack); 'full' = entire process memory"),
    },
    async ({ sessionId, outputPath, dumpType }) => {
      try {
        sessions.get(sessionId);

        const pathErr = validateOutputPath(outputPath);
        if (pathErr) {
          return { content: [{ type: "text" as const, text: `Error: ${pathErr}` }], isError: true };
        }

        const result = await bridgeFor(sessionId).call<{ fileSize: number }>(
          "debug.minidump", { sessionId, outputPath, dumpType }
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              savedTo: path.resolve(outputPath),
              fileSize: result.fileSize,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

}
