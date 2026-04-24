#!/usr/bin/env node
/**
 * x64dbg MCP Server — entry point
 *
 * Exposes x64dbg reverse-engineering and debugging capabilities via
 * the Model Context Protocol over STDIO transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridge } from "./bridge.js";
import { sessions } from "./session.js";
import { logger } from "./logger.js";
import { config } from "./config.js";
import { registerAllTools } from "./tools/index.js";
import { killDebugger } from "./launcher.js";

async function main(): Promise<void> {
  logger.info("x64dbg MCP Server starting …");
  logger.info(`x64dbg path : ${config.x64dbgPath}`);
  logger.info(`Bridge target: ${config.bridgeHost}:${config.bridgePort}`);

  // ── Create MCP server ───────────────────────────────────────────────

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

  // ── Register all tool groups ────────────────────────────────────────

  registerAllTools(server);

  // ── Connect to x64dbg bridge plugin ─────────────────────────────────

  try {
    await bridge.connect();
    logger.info("Bridge connection established");
  } catch (err) {
    logger.warn(
      `Bridge not available at startup (${err}). ` +
        "Tools will attempt to connect on first use."
    );
  }

  bridge.on("bridge-event", (event) => {
    logger.debug(`Bridge event: ${JSON.stringify(event)}`);
  });

  bridge.on("disconnected", () => {
    logger.error("Bridge disconnected and reconnect attempts exhausted");
  });

  bridge.on("reconnected", () => {
    logger.info("Bridge reconnected");
  });

  // ── Start session garbage collector ─────────────────────────────────

  sessions.start();

  // ── Start STDIO transport ───────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("x64dbg MCP Server is ready (STDIO transport)");

  // ── Graceful shutdown ───────────────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down …");
    sessions.stop();
    bridge.disconnect();
    killDebugger();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});
