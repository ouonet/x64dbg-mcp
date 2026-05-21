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
      "Returns a hex+ASCII dump. REQUIRES: state='paused'. " +
      "address: hex string ('0x00401000') or symbol ('rip', 'main'). " +
      "size: 1–65536 bytes (default 256). " +
      "Use get_memory_map(sessionId) to discover valid address ranges.",
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
    "Patch bytes in the debuggee's virtual memory. " +
      "Use to NOP instructions, modify data, or apply live patches. " +
      "CAUTION: writing to wrong addresses will crash the debuggee. " +
      "hexBytes: space-separated hex pairs, e.g. '90 90 90' for three NOPs or 'EB 05' for a short jump. " +
      "Returns: { status='written', address, bytesWritten }.",
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
    "Search the debuggee's virtual memory for a byte pattern or string. " +
      "searchType='hex': space-separated hex pairs with optional '??' wildcards, e.g. '4D 5A ?? ??'. " +
      "searchType='ascii'/'unicode': plain text search. " +
      "Returns: { totalFound, returned, truncated, matches: [{address, context}] }. " +
      "Use get_memory_map(sessionId) to find valid address ranges for startAddress/endAddress.",
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
    "List all virtual memory regions of the debuggee process: " +
      "base address, size, protection flags (R/W/X), type (image/mapped/private), and associated module. " +
      "Use this to discover what is mapped before calling read_memory or search_memory. " +
      "filterModule: restrict to regions belonging to a specific DLL or EXE. " +
      "filterProtection: restrict by protection, e.g. 'RWX' for executable+writable pages.",
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
    "Read CPU register values of the active thread. REQUIRES: state='paused'. " +
      "Returns: { general: {<reg>: hex_string}, flags: {ZF, CF, SF, OF, ...}, segment?, debug?, fpu? }. " +
      "x64: RAX, RBX, RCX, RDX, RSI, RDI, RSP, RBP, RIP, R8–R15, RFLAGS. " +
      "x86: EAX, EBX, ECX, EDX, ESI, EDI, ESP, EBP, EIP, EFLAGS. " +
      "Tip: get_status(sessionId) returns currentIP as a shortcut without fetching all registers.",
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
    "Get the call stack (backtrace) of the current thread. REQUIRES: state='paused'. " +
      "Returns: { threadId, frames: [{index, address, returnAddress, module, function, offset, args}] }. " +
      "Useful after an exception or unexpected pause to understand how execution reached the current point.",
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
    "List all threads in the debuggee process: TID, handle, entry address, TEB, state, priority, name. " +
      "Returns: { activeThreadId, threads: [ThreadInfo] }. " +
      "To switch the active thread: execute_command(sessionId, 'switchthread <id>').",
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
    "Dump a raw memory region from the debuggee to a file on disk. " +
      "Use to extract unpacked code sections, heap regions, or decoded payloads. " +
      "address: hex or symbol (e.g. 'rip', '0x401000'). size: max 256 MB. " +
      "outputPath: absolute path; parent directory must exist; file is overwritten silently. " +
      "Returns: { savedTo, bytesWritten }.",
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
    "Create a Windows minidump (.dmp) of the debuggee process for offline analysis. " +
      "dumpType='normal': small file — threads, modules, call stacks. " +
      "dumpType='full': large file — entire process memory (use for full offline analysis). " +
      "outputPath: absolute path; parent directory must exist. " +
      "Returns: { savedTo, fileSize }.",
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
