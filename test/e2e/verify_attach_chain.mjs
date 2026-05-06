import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolvePidFromEnv } from "./_target.mjs";

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

async function main() {
  const pid = resolvePidFromEnv("attach validation");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-attach-chain", version: "1.0.0" });
  let sessionId = null;

  try {
    await client.connect(transport);

    const attach = await client.callTool({
      name: "attach_to_process",
      arguments: {
        pid,
        breakOnEntry: true,
        autoAnalyze: true,
      },
    });
    const attachResult = parseJsonText(attach);
    sessionId = attachResult.sessionId;

    const registers = await client.callTool({
      name: "get_registers",
      arguments: {
        sessionId,
        includeSegment: false,
        includeDebug: false,
        includeFpu: false,
      },
    });
    const registerResult = parseJsonText(registers);

    const callStack = await client.callTool({
      name: "get_call_stack",
      arguments: {
        sessionId,
        maxFrames: 8,
      },
    });
    const stackResult = parseJsonText(callStack);

    const disasm = await client.callTool({
      name: "disassemble",
      arguments: {
        sessionId,
        address: attachResult.entryPoint,
        count: 12,
      },
    });
    const disasmText = extractText(disasm);
    if (!disasmText || disasmText.startsWith("Error:")) {
      throw new Error(disasmText || "disassemble returned empty response");
    }

    console.log("=== ATTACH ===");
    console.log(JSON.stringify(attachResult, null, 2));
    console.log("\n=== REGISTERS ===");
    console.log(JSON.stringify(registerResult, null, 2));
    console.log("\n=== CALL STACK ===");
    console.log(JSON.stringify(stackResult, null, 2));
    console.log("\n=== DISASSEMBLY ===");
    console.log(disasmText);
  } finally {
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