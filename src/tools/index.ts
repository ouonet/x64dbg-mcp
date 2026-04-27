/**
 * Tool registration barrel — registers all tool groups on the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../logger.js";
import { logToolCall } from "../logger.js";
import { registerDebugTools } from "./debug.js";
import { registerMemoryTools } from "./memory.js";
import { registerAnalysisTools } from "./analysis.js";
import { registerSecurityTools } from "./security.js";

export { logger };

type McpTextResult = { content: Array<{ type: "text"; text: string }>; isError?: true };
type ToolHandler<T> = (args: T) => Promise<McpTextResult>;

/**
 * Higher-order wrapper for MCP tool handlers.
 *
 * - Catches unhandled errors and converts them to `isError: true` responses.
 * - Logs each call with `logToolCall` (method name, duration, error if any).
 *
 * Usage:
 *   server.tool("my_tool", schema, wrapTool("my_tool", async ({ arg }) => { ... }));
 */
export function wrapTool<T>(method: string, fn: ToolHandler<T>): ToolHandler<T> {
  return async (args: T): Promise<McpTextResult> => {
    const t0 = Date.now();
    try {
      const result = await fn(args);
      logToolCall(method, "", Date.now() - t0, result.isError ? "tool returned isError" : undefined);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logToolCall(method, "", Date.now() - t0, msg);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    }
  };
}

export function registerAllTools(server: McpServer): void {
  registerDebugTools(server);
  registerMemoryTools(server);
  registerAnalysisTools(server);
  registerSecurityTools(server);
}
