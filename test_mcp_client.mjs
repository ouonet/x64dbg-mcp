/**
 * MCP E2E verification — Node.js client using the official SDK.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log("=".repeat(60));
  console.log("x64dbg MCP End-to-End Verification");
  console.log("=".repeat(60));

  // Step 1: Start the bridge in standalone mode
  console.log("\n[1/3] Starting bridge in standalone mode...");
  const bridgePy = path.join(__dirname, "plugin", "x64dbg_mcp_bridge.py");
  const bridge = spawn("python", [bridgePy], { stdio: "pipe" });
  bridge.stderr?.on("data", () => {});
  bridge.stdout?.on("data", () => {});

  await new Promise((r) => setTimeout(r, 2000));
  if (bridge.exitCode !== null) {
    console.log("  FAIL: Bridge exited early (code " + bridge.exitCode + ")");
    process.exit(1);
  }
  console.log("  OK: Bridge running (pid=" + bridge.pid + ")");

  // Quick TCP probe
  const net = await import("net");
  try {
    await new Promise((resolve, reject) => {
      const sock = net.default.createConnection(27042, "127.0.0.1", () => {
        const req = JSON.stringify({ id: "t1", method: "ping", params: {} }) + "\n";
        sock.write(req);
      });
      sock.on("data", (data) => {
        const resp = JSON.parse(data.toString().trim());
        console.log("  OK: TCP bridge responds (id=" + resp.id + ")");
        sock.destroy();
        resolve();
      });
      sock.on("error", reject);
      sock.setTimeout(3000, () => reject(new Error("TCP timeout")));
    });
  } catch (e) {
    console.log("  FAIL: TCP test:", e.message);
    bridge.kill();
    process.exit(1);
  }

  // Step 2: Connect MCP client to server via STDIO
  console.log("\n[2/3] Starting MCP server and connecting client...");
  const serverJs = path.join(__dirname, "dist", "server.js");

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverJs],
    env: {
      ...process.env,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: "27042",
    },
  });

  const client = new Client({ name: "test-verify", version: "1.0.0" });

  try {
    await client.connect(transport);
    console.log("  OK: MCP client connected");
    console.log("  Server:", client.getServerVersion());
  } catch (e) {
    console.log("  FAIL: MCP connect:", e.message);
    bridge.kill();
    process.exit(1);
  }

  // Step 3: List tools
  console.log("\n[3/3] Listing registered tools...");
  try {
    const result = await client.listTools();
    const tools = result.tools || [];
    console.log("  OK: " + tools.length + " tools registered:");
    for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log("      - " + t.name);
    }
  } catch (e) {
    console.log("  FAIL: listTools:", e.message);
  }

  // Cleanup
  console.log("\n" + "=".repeat(60));
  await client.close();
  bridge.kill();
  console.log("Verification complete.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
