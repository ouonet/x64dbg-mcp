import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveExecutablePath, resolvePidFromEnv } from "../../test/e2e/_target.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPort(host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (reachable) return;
    await sleep(250);
  }

  throw new Error(`HTTP MCP server did not open ${host}:${port} within ${timeoutMs}ms`);
}

function extractText(result) {
  return result?.content?.[0]?.text ?? "";
}

function parseJsonToolResult(result, toolName) {
  const text = extractText(result);
  if (!text || text.startsWith("Error:")) {
    throw new Error(text || `${toolName} returned empty response`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${toolName} returned non-JSON content: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveOptionalTargetExe() {
  if (!process.env.TARGET_EXE?.trim()) return null;
  return resolveExecutablePath("HTTP load validation");
}

function resolveOptionalTargetPid() {
  return resolvePidFromEnv("HTTP attach validation", { optional: true });
}

async function main() {
  const host = process.env.MCP_HTTP_HOST || "127.0.0.1";
  const port = Number.parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const endpointPath = "/mcp";
  const baseUrl = new URL(`http://${host}:${port}${endpointPath}`);
  const serverJs = path.join(repoRoot, "dist", "server.js");
  const targetExe = resolveOptionalTargetExe();
  const targetPid = resolveOptionalTargetPid();
  const attachTargetLabel = process.env.TARGET_PID?.trim()
    ? `TARGET_PID: ${process.env.TARGET_PID.trim()}`
    : process.env.TARGET_PROCESS_NAME?.trim()
    ? `TARGET_PROCESS_NAME: ${process.env.TARGET_PROCESS_NAME.trim()} (resolved PID ${targetPid})`
    : null;

  console.log("=".repeat(60));
  console.log("x64dbg MCP HTTP Smoke Test");
  console.log("=".repeat(60));
  console.log(`Endpoint: ${baseUrl.href}`);

  const server = spawn("node", [
    serverJs,
    "--transport",
    "streamable-http",
    "--host",
    host,
    "--port",
    String(port),
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  });

  const stderrLines = [];
  server.stderr?.setEncoding("utf8");
  server.stderr?.on("data", (chunk) => {
    const lines = String(chunk).split(/\r?\n/).filter(Boolean);
    stderrLines.push(...lines);
    while (stderrLines.length > 20) stderrLines.shift();
  });

  server.once("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      const tail = stderrLines.length ? `\n--- server stderr ---\n${stderrLines.join("\n")}` : "";
      console.error(`HTTP MCP server exited early with code ${code}${signal ? ` (signal ${signal})` : ""}${tail}`);
    }
  });

  let client;
  let transport;
  let sessionId = null;

  try {
    console.log("\n[1/5] Waiting for HTTP server to listen...");
    await waitForPort(host, port);
    if (server.exitCode !== null) {
      throw new Error(`Server exited before accepting connections (code ${server.exitCode})`);
    }
    console.log("  OK: HTTP endpoint is reachable");

    console.log("\n[2/5] Connecting official MCP HTTP client...");
    transport = new StreamableHTTPClientTransport(baseUrl);
    client = new Client({ name: "http-smoke-test", version: "1.0.0" });
    await client.connect(transport);
    console.log("  OK: MCP client connected");
    console.log("  Server:", client.getServerVersion());
    console.log("  Session:", transport.sessionId || "<stateless>");

    console.log("\n[3/5] Calling get_status...");
    const statusResult = await client.callTool({
      name: "get_status",
      arguments: {},
    });
    const status = parseJsonToolResult(statusResult, "get_status");
    if (typeof status.bridgeConnected !== "boolean") {
      throw new Error("get_status did not include bridgeConnected boolean");
    }
    if (typeof status.activeSessions !== "number") {
      throw new Error("get_status did not include activeSessions count");
    }
    console.log("  OK: get_status returned live server state");
    console.log("  bridgeConnected:", status.bridgeConnected);
    console.log("  activeSessions:", status.activeSessions);

    console.log("\n[4/5] Listing registered tools...");
    const result = await client.listTools();
    const tools = [...(result.tools || [])].sort((a, b) => a.name.localeCompare(b.name));
    console.log(`  OK: ${tools.length} tools registered`);
    for (const tool of tools) {
      console.log(`      - ${tool.name}`);
    }

    console.log("\n[5/5] Running optional debugger validations...");
    if (targetExe) {
      console.log(`  TARGET_EXE: ${targetExe}`);
      const loadResult = await client.callTool({
        name: "load_executable",
        arguments: {
          executablePath: targetExe,
          breakOnEntry: true,
          autoAnalyze: true,
        },
      });
      const loaded = parseJsonToolResult(loadResult, "load_executable");
      sessionId = loaded.sessionId || null;
      if (!sessionId) {
        throw new Error("load_executable did not return sessionId");
      }

      const loadedStatusResult = await client.callTool({
        name: "get_status",
        arguments: { sessionId },
      });
      const loadedStatus = parseJsonToolResult(loadedStatusResult, "get_status(session)");
      console.log("  OK: load_executable succeeded");
      console.log("  sessionId:", sessionId);
      console.log("  pid:", loaded.pid);
      console.log("  entryPoint:", loaded.entryPoint);
      console.log("  state:", loadedStatus.session?.state ?? "<unknown>");

      await client.callTool({
        name: "terminate_session",
        arguments: { sessionId },
      });
      console.log("  OK: terminate_session completed for load_executable");
      sessionId = null;
    } else {
      console.log("  SKIP: Set TARGET_EXE to validate load_executable over HTTP.");
    }

    if (targetPid) {
      console.log(`  ${attachTargetLabel ?? `resolved attach target PID: ${targetPid}`}`);
      const attachResult = await client.callTool({
        name: "attach_to_process",
        arguments: {
          pid: targetPid,
          breakOnEntry: true,
          autoAnalyze: true,
        },
      });
      const attached = parseJsonToolResult(attachResult, "attach_to_process");
      sessionId = attached.sessionId || null;
      if (!sessionId) {
        throw new Error("attach_to_process did not return sessionId");
      }

      const attachedStatusResult = await client.callTool({
        name: "get_status",
        arguments: { sessionId },
      });
      const attachedStatus = parseJsonToolResult(attachedStatusResult, "get_status(attach session)");
      console.log("  OK: attach_to_process succeeded");
      console.log("  sessionId:", sessionId);
      console.log("  pid:", attached.pid);
      console.log("  entryPoint:", attached.entryPoint);
      console.log("  state:", attachedStatus.session?.state ?? "<unknown>");

      await client.callTool({
        name: "terminate_session",
        arguments: { sessionId },
      });
      console.log("  OK: terminate_session completed for attach_to_process");
      sessionId = null;
    } else {
      console.log("  SKIP: Set TARGET_PID or TARGET_PROCESS_NAME to validate attach_to_process over HTTP.");
    }

    console.log("\n[cleanup] Terminating debug session if needed...");
    if (sessionId) {
      await client.callTool({
        name: "terminate_session",
        arguments: { sessionId },
      });
      console.log("  OK: terminate_session completed");
      sessionId = null;
    } else {
      console.log("  OK: no debug session to terminate");
    }

    console.log("\n[cleanup] Terminating HTTP session...");
    await transport.terminateSession();
    console.log("  OK: HTTP session terminated cleanly");
  } finally {
    try {
      if (sessionId) {
        await client?.callTool({
          name: "terminate_session",
          arguments: { sessionId },
        });
      }
    } catch {}

    try {
      await client?.callTool({
        name: "close_debugger",
        arguments: { force: true },
      });
    } catch {}

    try {
      await client?.close();
    } catch {}

    try {
      await transport?.close();
    } catch {}

    if (server.exitCode === null) {
      server.kill();
      await new Promise((resolve) => server.once("exit", resolve));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("HTTP smoke test complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});