import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "x64dbg-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerAllTools(server);
  return server;
}