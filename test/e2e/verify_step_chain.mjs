import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveExecutablePath, resolvePidFromEnv } from "./_target.mjs";

function extractText(result) {
  return result?.content?.[0]?.text ?? "";
}

function parseJsonText(result) {
  const text = extractText(result);
  if (!text || text.startsWith("Error:")) {
    throw new Error(text || "Tool returned empty response");
  }
  return JSON.parse(text);
}

async function callJson(client, name, args) {
  return parseJsonText(await client.callTool({ name, arguments: args }));
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-step-chain", version: "1.0.0" });
  let sessionId = null;
  let breakpointAddress = null;

  try {
    await client.connect(transport);

    let attach;
    const pid = resolvePidFromEnv("stepping validation", { optional: true });
    if (pid) {
      attach = await callJson(client, "attach_to_process", {
        pid,
        breakOnEntry: true,
        autoAnalyze: true,
      });
    } else {
      const executablePath = resolveExecutablePath("stepping validation");
      attach = await callJson(client, "load_executable", {
        executablePath,
        breakOnEntry: true,
        autoAnalyze: true,
      });
    }
    sessionId = attach.sessionId;

    const stepInto = await callJson(client, "step_into", {
      sessionId,
      count: 1,
    });

    const stepOver = await callJson(client, "step_over", {
      sessionId,
      count: 1,
    });

    breakpointAddress = stepOver.address;
    const breakpoint = await callJson(client, "set_breakpoint", {
      sessionId,
      address: breakpointAddress,
      type: "software",
      name: "verify-continue-hit",
    });

    const continued = await callJson(client, "continue_execution", {
      sessionId,
    });

    console.log("=== ATTACH ===");
    console.log(JSON.stringify(attach, null, 2));
    console.log("\n=== STEP INTO ===");
    console.log(JSON.stringify(stepInto, null, 2));
    console.log("\n=== STEP OVER ===");
    console.log(JSON.stringify(stepOver, null, 2));
    console.log("\n=== BREAKPOINT ===");
    console.log(JSON.stringify(breakpoint, null, 2));
    console.log("\n=== CONTINUE ===");
    console.log(JSON.stringify(continued, null, 2));

    if (continued.stopReason !== "breakpoint") {
      throw new Error(`continue_execution returned unexpected stopReason: ${continued.stopReason}`);
    }

    if (continued.currentAddress !== breakpointAddress) {
      throw new Error(
        `continue_execution stopped at ${continued.currentAddress}, expected breakpoint ${breakpointAddress}`
      );
    }
  } finally {
    try {
      if (sessionId && breakpointAddress) {
        await client.callTool({
          name: "remove_breakpoint",
          arguments: { sessionId, address: breakpointAddress },
        });
      }
    } catch {}

    try {
      if (sessionId) {
        await client.callTool({
          name: "terminate_session",
          arguments: { sessionId },
        });
      }
    } catch {}

    try {
      await client.callTool({
        name: "close_debugger",
        arguments: { force: true },
      });
    } catch {}

    await client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});