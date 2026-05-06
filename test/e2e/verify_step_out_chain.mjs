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

function parseDisassembly(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith(";"))
    .map((line) => {
      const match = line.match(/^(0x[0-9A-Fa-f]+)\s+(.+?)\s{2,}([A-Za-z.]+)\s*(.*)$/);
      if (!match) return null;
      return {
        address: match[1],
        bytes: match[2].trim(),
        mnemonic: match[3].toLowerCase(),
        operands: match[4].trim(),
      };
    })
    .filter(Boolean);
}

async function main() {
  const executablePath = resolveExecutablePath("step_out validation");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-step-out-chain", version: "1.0.0" });
  let sessionId = null;

  try {
    await client.connect(transport);

    const loaded = await callJson(client, "load_executable", {
      executablePath,
      breakOnEntry: true,
      autoAnalyze: true,
    });
    sessionId = loaded.sessionId;

    let callInstruction = null;
    let expectedReturn = null;
    let stepOverCount = 0;

    for (; stepOverCount < 80; stepOverCount += 1) {
      const currentLocation = stepOverCount === 0
        ? { address: loaded.entryPoint }
        : await callJson(client, "get_status", { sessionId });
      const currentAddress = currentLocation.currentIP || currentLocation.address || loaded.entryPoint;

      const disassemblyText = extractText(await client.callTool({
        name: "disassemble",
        arguments: {
          sessionId,
          address: currentAddress,
          count: 2,
        },
      }));
      if (!disassemblyText || disassemblyText.startsWith("Error:")) {
        throw new Error(disassemblyText || "disassemble returned empty response");
      }

      const instructions = parseDisassembly(disassemblyText);
      if (instructions.length >= 2 && instructions[0].mnemonic === "call") {
        callInstruction = instructions[0];
        expectedReturn = instructions[1].address;
        break;
      }

      await callJson(client, "step_over", { sessionId, count: 1 });
    }

    if (!callInstruction || !expectedReturn) {
      throw new Error("Could not reach a suitable call instruction for step_out validation within 80 step_over operations");
    }

    const stackBefore = await callJson(client, "get_call_stack", {
      sessionId,
      maxFrames: 8,
    });

    const steppedInto = await callJson(client, "step_into", {
      sessionId,
      count: 1,
    });

    const steppedOut = await callJson(client, "step_out", {
      sessionId,
    });

    const stackAfter = await callJson(client, "get_call_stack", {
      sessionId,
      maxFrames: 8,
    });

    const registersAfter = await callJson(client, "get_registers", {
      sessionId,
      includeSegment: false,
      includeDebug: false,
      includeFpu: false,
    });

    console.log("=== LOAD ===");
    console.log(JSON.stringify(loaded, null, 2));
    console.log("\n=== CALL SITE ===");
    console.log(JSON.stringify({ callInstruction, expectedReturn, stepOverCount }, null, 2));
    console.log("\n=== STACK BEFORE ===");
    console.log(JSON.stringify(stackBefore, null, 2));
    console.log("\n=== STEP INTO ===");
    console.log(JSON.stringify(steppedInto, null, 2));
    console.log("\n=== STEP OUT ===");
    console.log(JSON.stringify(steppedOut, null, 2));
    console.log("\n=== STACK AFTER ===");
    console.log(JSON.stringify(stackAfter, null, 2));
    console.log("\n=== REGISTERS AFTER ===");
    console.log(JSON.stringify(registersAfter, null, 2));

    const beforeTop = stackBefore.frames?.[0]?.address;
    const currentIp = registersAfter.general?.eip ?? registersAfter.general?.rip;

    if (!beforeTop || !currentIp) {
      throw new Error("Missing pre-step call-stack or post-step register state");
    }

    if (steppedInto.address === callInstruction.address) {
      throw new Error(`step_into did not enter the callee from ${callInstruction.address}`);
    }

    if (steppedOut.address !== expectedReturn) {
      throw new Error(
        `step_out returned ${steppedOut.address}, expected ${expectedReturn} after call at ${callInstruction.address}`
      );
    }

    if (currentIp !== steppedOut.address) {
      throw new Error(
        `step_out returned ${steppedOut.address}, but current IP is ${currentIp}`
      );
    }
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