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

function isSequentialMnemonic(mnemonic) {
  return !/^(call|j|loop|ret|iret|syscall|sysenter|int)/.test(mnemonic);
}

async function main() {
  const executablePath = resolveExecutablePath("run_to_address validation");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-run-to-address-chain", version: "1.0.0" });
  let sessionId = null;

  try {
    await client.connect(transport);

    const loaded = await callJson(client, "load_executable", {
      executablePath,
      breakOnEntry: true,
      autoAnalyze: true,
    });
    sessionId = loaded.sessionId;

    let selected = null;
    let searchSteps = 0;
    let currentAddress = loaded.entryPoint;

    for (; searchSteps < 40; searchSteps += 1) {
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
      if (instructions.length >= 2 && isSequentialMnemonic(instructions[0].mnemonic)) {
        selected = {
          from: instructions[0],
          target: instructions[1].address,
        };
        break;
      }

      const stepped = await callJson(client, "step_over", {
        sessionId,
        count: 1,
      });
      currentAddress = stepped.address;
    }

    if (!selected) {
      throw new Error("Could not find a sequential instruction for run_to_address validation within 40 step_over operations");
    }

    const runTo = await callJson(client, "run_to_address", {
      sessionId,
      address: selected.target,
    });

    const registersAfter = await callJson(client, "get_registers", {
      sessionId,
      includeSegment: false,
      includeDebug: false,
      includeFpu: false,
    });

    console.log("=== LOAD ===");
    console.log(JSON.stringify(loaded, null, 2));
    console.log("\n=== SELECTED INSTRUCTION ===");
    console.log(JSON.stringify({ ...selected, searchSteps }, null, 2));
    console.log("\n=== RUN TO ADDRESS ===");
    console.log(JSON.stringify(runTo, null, 2));
    console.log("\n=== REGISTERS AFTER ===");
    console.log(JSON.stringify(registersAfter, null, 2));

    const currentIp = registersAfter.general?.eip ?? registersAfter.general?.rip;

    if (!runTo.reached) {
      throw new Error(
        `run_to_address did not reach target ${selected.target}; stopped at ${runTo.stopAddress} (${runTo.reason})`
      );
    }

    if (runTo.stopAddress !== selected.target) {
      throw new Error(
        `run_to_address stopped at ${runTo.stopAddress}, expected ${selected.target}`
      );
    }

    if (currentIp !== selected.target) {
      throw new Error(
        `run_to_address stopped at ${runTo.stopAddress}, but current IP is ${currentIp}`
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