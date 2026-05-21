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

  server.registerTool(
    "disassemble",
    {
      description: "Disassemble instructions starting at an address or symbol. " +
      "Returns: header (startAddress, functionName, count) followed by lines of " +
      "'address  bytes  mnemonic operands  ; comment'. " +
      "address: hex ('0x401000') or symbol ('main', 'CreateFileW', 'kernel32.CreateFileW'). " +
      "Safe to call while paused or while analysing a loaded module. " +
      "Tip: pass the entryPoint returned by load_executable to inspect the PE entry code immediately.",
      inputSchema: {
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

  server.registerTool(
    "analyze_function",
    {
      description: "Analyze a function: boundaries, size, instruction count, call graph, and isLeaf flag. " +
      "Returns: { address, endAddress, size, instructionCount, callers (who calls this), callees (what this calls), isLeaf }. " +
      "address: any address inside the function, or a symbol name.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      address: z
        .string()
        .describe("Any address inside the function, or its symbol name"),
    },
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

  server.registerTool(
    "get_cross_references",
    {
      description: "Find all cross-references (xrefs) to or from an address. " +
      "direction='to': who references this address (callers, data readers). " +
      "direction='from': what this address references (callees, data it reads). " +
      "direction='both': both directions. " +
      "Returns: { address, xrefsTo: [{from, to, type, instruction, module}], xrefsFrom: [...] }. " +
      "type values: 'call', 'jump', 'data_read', 'data_write', 'unknown'.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      address: z.string().describe("Target address or symbol"),
      direction: z
        .enum(["to", "from", "both"])
        .default("to")
        .describe("'to' = who references this address, 'from' = what this address references"),
    },
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

  server.registerTool(
    "list_functions",
    {
      description: "List all recognized functions in the debuggee: address, name, size, module. " +
      "module: filter by module name (e.g. 'target.exe'). " +
      "nameFilter: substring match on function name. " +
      "Paginated via offset/limit (default limit=100, max=500).",
      inputSchema: {
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

  server.registerTool(
    "get_modules",
    {
      description: "List all modules (main EXE + loaded DLLs): name, path, base address, size, entry point, sections. " +
      "Use after load_executable to see which DLLs are mapped, " +
      "or to find a module's base address for offset calculations.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
    },
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

  server.registerTool(
    "get_imports",
    {
      description: "List imported functions for a module: importing DLL name, function name, ordinal, IAT address. " +
      "module: defaults to main executable. dllFilter/functionFilter: substring filters. " +
      "Use analyze_suspicious_apis to cross-reference imports against malware API patterns.",
      inputSchema: {
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

  server.registerTool(
    "get_exports",
    {
      description: "List exported functions/symbols from a PE module's export table: name, ordinal, address, forwarder. " +
      "module: required (e.g. 'kernel32.dll'). nameFilter: substring filter on export name.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      module: z.string().describe("Module name (e.g. 'kernel32.dll')"),
      nameFilter: z
        .string()
        .optional()
        .describe("Filter by export name substring"),
    },
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

  server.registerTool(
    "find_strings",
    {
      description: "Find ASCII and Unicode strings in the debuggee's mapped memory. " +
      "Returns: { totalFound, strings: [{address, value, type, length, referencedBy}], truncated }. " +
      "module: limit search to a specific DLL or EXE. filter: substring match. minLength: default 4. " +
      "Use to quickly locate hardcoded URLs, registry keys, encryption keys, or debug messages.",
      inputSchema: {
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

  server.registerTool(
    "get_pe_header",
    {
      description: "Parse the PE header of a loaded module. " +
      "Returns: machine type, timestamp, imageBase, imageSize, entryPoint, subsystem, " +
      "characteristics, dllCharacteristics, sections (with entropy per section), data directories. " +
      "module: defaults to main executable. " +
      "Use with detect_packing to correlate high-entropy sections with PE structure.",
      inputSchema: {
      sessionId: z.string().describe("Session ID"),
      module: z
        .string()
        .optional()
        .describe("Module name (default: main executable)"),
    },
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

}
