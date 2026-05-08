/**
 * Static and dynamic analysis tools — disassembly, xrefs, imports, exports, strings, modules
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeFor } from "../bridgeRegistry.js";
import { sessions } from "../session.js";
import { config } from "../config.js";
import type {
  Instruction,
  FunctionInfo,
  CrossReference,
  StringReference,
  ModuleInfo,
  ImportEntry,
  ExportEntry,
} from "../types.js";

export function registerAnalysisTools(server: McpServer): void {
  // ── Disassemble ───────────────────────────────────────────────────────

  server.tool(
    "disassemble",
    "Disassemble instructions starting at a given address in the loaded module. " +
      "Returns address, raw bytes, mnemonic, operands, and metadata " +
      "(is_call, is_jump, reference target) for each instruction. " +
      "Safe to call while paused. Address may be a hex value ('0x401000') or " +
      "a symbol name ('main', 'kernel32.CreateFileW'). " +
      "Tip: after load_executable with breakOnEntry=true, disassemble the entry point " +
      "returned in the load result to see where execution begins.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z
        .string()
        .describe("Start address (hex) or symbol, e.g. '0x401000' or 'main'"),
      count: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(30)
        .describe("Number of instructions (default 30)"),
    },
    async ({ sessionId, address, count }) => {
      try {
        sessions.get(sessionId);
        const cappedCount = Math.min(count, config.maxDisasmInstructions);

        const result = await bridgeFor(sessionId).call<{
          startAddress: string;
          functionName?: string;
          instructions: Instruction[];
        }>("analysis.disassemble", { sessionId, address, count: cappedCount });

        const lines = result.instructions.map((i) => {
          let line = `${i.address}  ${i.bytes.padEnd(24)}  ${i.mnemonic} ${i.operands}`;
          if (i.comment) line += `  ; ${i.comment}`;
          return line;
        });

        let header = `; Disassembly at ${result.startAddress}`;
        if (result.functionName) header += ` (${result.functionName})`;
        header += `\n; ${result.instructions.length} instructions\n`;

        return {
          content: [{ type: "text" as const, text: header + lines.join("\n") }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Analyse function ──────────────────────────────────────────────────

  server.tool(
    "analyze_function",
    "Analyse the function that contains the given address. " +
      "Returns boundaries, size, call graph (callers + callees), " +
      "and whether the function is a leaf.",
    {
      sessionId: z.string().describe("Session ID"),
      address: z
        .string()
        .describe("Any address inside the function, or its symbol name"),
    },
    async ({ sessionId, address }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<FunctionInfo>(
          "analysis.analyzeFunction",
          { sessionId, address }
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Cross-references ──────────────────────────────────────────────────

  server.tool(
    "get_cross_references",
    "Find all cross-references (xrefs) to or from the given address. " +
      "Returns code references (calls/jumps) and data references (reads/writes).",
    {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Target address or symbol"),
      direction: z
        .enum(["to", "from", "both"])
        .default("to")
        .describe("'to' = who references this address, 'from' = what this address references"),
    },
    async ({ sessionId, address, direction }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          address: string;
          xrefsTo: CrossReference[];
          xrefsFrom: CrossReference[];
        }>("analysis.getXrefs", { sessionId, address, direction });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── List functions ────────────────────────────────────────────────────

  server.tool(
    "list_functions",
    "List recognised functions in the debuggee. " +
      "Can filter by module name and/or name substring.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name filter (e.g. 'target.exe')"),
      nameFilter: z
        .string()
        .optional()
        .describe("Substring filter on function name"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      limit: z.number().int().min(1).max(500).default(100).describe("Max results"),
    },
    async ({ sessionId, module, nameFilter, offset, limit }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          total: number;
          functions: { address: string; name: string; size: number; module: string }[];
        }>("analysis.listFunctions", { sessionId, module, nameFilter, offset, limit });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get modules ───────────────────────────────────────────────────────

  server.tool(
    "get_modules",
    "List all modules (DLLs and the main EXE) loaded in the debuggee " +
      "with base address, size, entry point, and file path.",
    {
      sessionId: z.string().describe("Session ID"),
    },
    async ({ sessionId }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{ modules: ModuleInfo[] }>(
          "analysis.getModules",
          { sessionId }
        );

        sessions.setModules(sessionId, result.modules);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get imports ───────────────────────────────────────────────────────

  server.tool(
    "get_imports",
    "List all imported functions for a specific module. " +
      "Shows DLL name, function name, ordinal, and IAT address.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
      dllFilter: z
        .string()
        .optional()
        .describe("Filter by importing DLL name substring"),
      functionFilter: z
        .string()
        .optional()
        .describe("Filter by function name substring"),
    },
    async ({ sessionId, module, dllFilter, functionFilter }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          module: string;
          totalImports: number;
          imports: ImportEntry[];
        }>("analysis.getImports", { sessionId, module, dllFilter, functionFilter });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get exports ───────────────────────────────────────────────────────

  server.tool(
    "get_exports",
    "List all exported functions/symbols for a specific module.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z.string().describe("Module name (e.g. 'kernel32.dll')"),
      nameFilter: z
        .string()
        .optional()
        .describe("Filter by export name substring"),
    },
    async ({ sessionId, module, nameFilter }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          module: string;
          totalExports: number;
          exports: ExportEntry[];
        }>("analysis.getExports", { sessionId, module, nameFilter });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Find strings ──────────────────────────────────────────────────────

  server.tool(
    "find_strings",
    "Search for ASCII and Unicode strings in the debuggee's memory. " +
      "Optionally filter by content substring or module.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Limit search to a specific module"),
      filter: z
        .string()
        .optional()
        .describe("Substring filter on string content"),
      minLength: z
        .number()
        .int()
        .min(3)
        .max(1000)
        .default(4)
        .describe("Minimum string length (default 4)"),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(200)
        .describe("Maximum results (default 200)"),
    },
    async ({ sessionId, module, filter, minLength, maxResults }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          totalFound: number;
          strings: StringReference[];
          truncated: boolean;
        }>("analysis.findStrings", {
          sessionId,
          module,
          filter,
          minLength,
          maxResults: Math.min(maxResults, config.maxSearchResults),
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Get PE header info ────────────────────────────────────────────────

  server.tool(
    "get_pe_header",
    "Parse and return the PE header information for a module: " +
      "DOS header, NT headers, section table, data directories, " +
      "timestamp, subsystem, characteristics, etc.",
    {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
    async ({ sessionId, module }) => {
      try {
        sessions.get(sessionId);

        const result = await bridgeFor(sessionId).call<{
          module: string;
          machine: string;
          timestamp: string;
          entryPoint: string;
          imageBase: string;
          imageSize: string;
          subsystem: string;
          characteristics: string[];
          dllCharacteristics: string[];
          sections: {
            name: string;
            virtualAddress: string;
            virtualSize: string;
            rawSize: string;
            characteristics: string[];
            entropy: number;
          }[];
          dataDirectories: { name: string; address: string; size: string }[];
        }>("analysis.getPEHeader", { sessionId, module });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── Trace execution ───────────────────────────────────────────────────

  server.tool(
    "trace_execution",
    "Record an execution trace from the current position. " +
      "Steps through instructions and records address + disassembly " +
      "at each step. Stops after maxInstructions or a breakpoint.",
    {
      sessionId: z.string().describe("Session ID"),
      maxInstructions: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .default(500)
        .describe("Maximum instructions to trace (default 500)"),
      traceInto: z
        .boolean()
        .default(false)
        .describe("true = step into calls, false = step over calls"),
      recordRegisters: z
        .boolean()
        .default(false)
        .describe("Record full register state at each step (slower)"),
      breakOnCall: z
        .string()
        .optional()
        .describe("Stop tracing when this function/address is called"),
    },
    async ({ sessionId, maxInstructions, traceInto, recordRegisters, breakOnCall }) => {
      try {
        sessions.get(sessionId);
        sessions.updateState(sessionId, "running");

        const capped = Math.min(maxInstructions, config.maxTraceInstructions);

        const result = await bridgeFor(sessionId).call<{
          instructionsTraced: number;
          stopReason: string;
          trace: {
            address: string;
            disassembly: string;
            registers?: Record<string, string>;
          }[];
        }>(
          "analysis.trace",
          { sessionId, maxInstructions: capped, traceInto, recordRegisters, breakOnCall },
          capped > 1000 ? 120_000 : 60_000 // extended timeout for long traces
        );

        sessions.updateState(sessionId, "paused");

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  instructionsTraced: result.instructionsTraced,
                  stopReason: result.stopReason,
                  trace: result.trace,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        sessions.updateState(sessionId, "paused");
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
