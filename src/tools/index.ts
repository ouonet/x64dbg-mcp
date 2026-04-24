/**
 * Tool registration barrel — registers all tool groups on the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDebugTools } from "./debug.js";
import { registerMemoryTools } from "./memory.js";
import { registerAnalysisTools } from "./analysis.js";
import { registerSecurityTools } from "./security.js";

export function registerAllTools(server: McpServer): void {
  registerDebugTools(server);
  registerMemoryTools(server);
  registerAnalysisTools(server);
  registerSecurityTools(server);
}
