import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";
import { notificationBus } from "./session.js";
import type { DebugEvent, PauseReason, TerminationReason } from "./types.js";
import type { DebugState } from "./types.js";

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

  // D7 — forward per-session debug events and state changes to MCP client as notifications.
  notificationBus.on("debugEvent", (sessionId: string, event: DebugEvent) => {
    server.server.notification({
      method: "x64dbg/debugEvent",
      params: { sessionId, event },
    } as Parameters<typeof server.server.notification>[0]).catch(() => { /* transport not connected */ });
  });

  notificationBus.on("stateChange", (sessionId: string, state: {
    state: DebugState;
    pauseReason: PauseReason | null;
    terminationReason: TerminationReason | null;
  }) => {
    server.server.notification({
      method: "x64dbg/stateChange",
      params: { sessionId, ...state },
    } as Parameters<typeof server.server.notification>[0]).catch(() => { /* transport not connected */ });
  });

  return server;
}