import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveExecutablePath } from "./_target.mjs";


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
  const executablePath = resolveExecutablePath("breakpoint validation");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-breakpoint-chain", version: "1.0.0" });
  let sessionId = null;
  let breakpointAddress = null;

  try {
    await client.connect(transport);

    const loaded = await callJson(client, "load_executable", {
      executablePath,
      breakOnEntry: true,
      autoAnalyze: true,
    });
    sessionId = loaded.sessionId;

    const stepped = await callJson(client, "step_into", {
      sessionId,
      count: 1,
    });
    breakpointAddress = stepped.address;

    const breakpoint = await callJson(client, "set_breakpoint", {
      sessionId,
      address: breakpointAddress,
      type: "software",
      name: "verify-breakpoint-chain",
    });

    const listedBefore = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    const continued = await callJson(client, "continue_execution", {
      sessionId,
    });

    const listedAfter = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    const removed = await callJson(client, "remove_breakpoint", {
      sessionId,
      address: breakpointAddress,
    });

    const listedFinal = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    console.log("=== LOAD ===");
    console.log(JSON.stringify(loaded, null, 2));
    console.log("\n=== STEP INTO ===");
    console.log(JSON.stringify(stepped, null, 2));
    console.log("\n=== SET BREAKPOINT ===");
    console.log(JSON.stringify(breakpoint, null, 2));
    console.log("\n=== LIST BEFORE ===");
    console.log(JSON.stringify(listedBefore, null, 2));
    console.log("\n=== CONTINUE ===");
    console.log(JSON.stringify(continued, null, 2));
    console.log("\n=== LIST AFTER ===");
    console.log(JSON.stringify(listedAfter, null, 2));
    console.log("\n=== REMOVE BREAKPOINT ===");
    console.log(JSON.stringify(removed, null, 2));
    console.log("\n=== LIST FINAL ===");
    console.log(JSON.stringify(listedFinal, null, 2));

    if (continued.stopReason !== "breakpoint") {
      throw new Error(`continue_execution returned unexpected stopReason: ${continued.stopReason}`);
    }

    if (continued.currentAddress !== breakpointAddress) {
      throw new Error(
        `continue_execution stopped at ${continued.currentAddress}, expected breakpoint ${breakpointAddress}`
      );
    }

    const beforeHit = listedBefore.breakpoints.find((bp) => bp.address === breakpointAddress);
    if (!beforeHit) {
      throw new Error(`Breakpoint ${breakpointAddress} not present in list_breakpoints before continue`);
    }

    const afterHit = listedAfter.breakpoints.find((bp) => bp.address === breakpointAddress);
    if (!afterHit) {
      throw new Error(`Breakpoint ${breakpointAddress} not present in list_breakpoints after continue`);
    }

    if (listedFinal.breakpoints.some((bp) => bp.address === breakpointAddress)) {
      throw new Error(`Breakpoint ${breakpointAddress} still present after remove_breakpoint`);
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