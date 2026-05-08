#!/usr/bin/env node
/**
 * x64dbg MCP Server — entry point
 *
 * Exposes x64dbg reverse-engineering and debugging capabilities via
 * the Model Context Protocol over STDIO transport.
 *
 * Subcommands (run BEFORE heavy imports so config errors don't block them):
 *   x64dbg-mcp setup          — interactive configuration wizard
 *   x64dbg-mcp doctor         — pre-flight diagnostics
 *   x64dbg-mcp install-plugin — compile C loader & deploy to x64dbg
 *   x64dbg-mcp                — start MCP server (default)
 */

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { detectServiceMode, parseCliRuntimeOverrides, renderCliUsage } from "./cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const subcommand = process.argv[2];
if (subcommand === "setup" || subcommand === "doctor" || subcommand === "install-plugin") {
  const scriptMap: Record<string, string> = {
    setup: "setup.mjs",
    doctor: "doctor.mjs",
    "install-plugin": "install-plugin.mjs",
  };
  const scriptPath = path.resolve(__dirname, "..", "scripts", scriptMap[subcommand]);
  const result = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(3)], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

const rawArgv = process.argv.slice(2);
const serviceMode = detectServiceMode(rawArgv);
if (serviceMode) {
  const { runService } = await import("./service/router.js");
  const exitCode = await runService(serviceMode.serviceArgv);
  process.exit(exitCode);
}

let cliOverrides: ReturnType<typeof parseCliRuntimeOverrides>;
try {
  cliOverrides = parseCliRuntimeOverrides(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  console.error("");
  console.error(renderCliUsage());
  process.exit(1);
}

if (cliOverrides.showHelp) {
  console.log(renderCliUsage());
  process.exit(0);
}

// ── Dynamic imports: only loaded when running as MCP server ────────────────
// (keeps setup/doctor from failing when .env / BRIDGE_AUTH_TOKEN is missing)
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { bridge } = await import("./bridge.js");
const { sessions } = await import("./session.js");
const { logger } = await import("./logger.js");
const { config } = await import("./config.js");
const { createMcpServer } = await import("./mcpServer.js");
const { startHttpMcpServer } = await import("./httpServer.js");
const { killDebugger } = await import("./launcher.js");

const runtimeTransport = cliOverrides.transport ?? config.mcpTransport;
const runtimeHttpHost = cliOverrides.host ?? config.mcpHttpHost;
const runtimeHttpPort = cliOverrides.port ?? config.mcpHttpPort;
const runtimeHttpPath = "/mcp";

function bindBridgeLifecycle(): void {
  bridge.on("bridge-event", (event) => {
    logger.debug(`Bridge event: ${JSON.stringify(event)}`);
  });

  bridge.on("disconnected", () => {
    logger.error(
      "Bridge disconnected — all reconnect attempts exhausted. " +
      "Restart x64dbg and run the MCP server again."
    );
    for (const s of sessions.list()) {
      logger.warn(`Terminating session ${s.id} (${s.executable}) — bridge gone`);
      sessions.terminate(s.id);
    }
  });

  bridge.on("reconnected", () => {
    logger.info("Bridge reconnected");
  });
}

async function main(): Promise<void> {
  logger.info("x64dbg MCP Server starting …");
  logger.info(`x64dbg path : ${config.x64dbgPath}`);
  logger.info(`Bridge target: ${config.bridgeHost}:${config.bridgePort}`);
  logger.info(`MCP transport: ${runtimeTransport}`);

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

  bindBridgeLifecycle();

  // ── Start session garbage collector ─────────────────────────────────

  sessions.start();

  let closeTransport = async (): Promise<void> => {};

  if (runtimeTransport === "streamable-http") {
    const httpServer = await startHttpMcpServer({
      host: runtimeHttpHost,
      port: runtimeHttpPort,
      path: runtimeHttpPath,
      createServer: createMcpServer,
    });
    closeTransport = httpServer.close;
    logger.info(
      `x64dbg MCP Server is ready (Streamable HTTP transport at http://${httpServer.host}:${httpServer.port}${httpServer.path})`
    );
  } else {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    closeTransport = async () => {
      await server.close();
    };
    logger.info("x64dbg MCP Server is ready (STDIO transport)");
  }

  // ── Graceful shutdown ───────────────────────────────────────────────

  const shutdown = async (): Promise<void> => {
    logger.info("Shutting down …");
    await closeTransport();
    sessions.stop();
    // Drain in-flight bridge requests before closing the socket.
    await bridge.drain(5_000);
    // Wait for the socket to fully close before killing the debugger process.
    await bridge.disconnect();
    killDebugger();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (runtimeTransport === "stdio") {
    // On Windows SIGTERM is unreliable; detect MCP host closing the pipe instead.
    process.stdin.on("close", shutdown);
  }
}

main().catch((err) => {
  // logger may not be initialised if config failed to load
  try { logger.error(`Fatal: ${err}`); } catch { console.error(`Fatal: ${err}`); }
  process.exit(1);
});
