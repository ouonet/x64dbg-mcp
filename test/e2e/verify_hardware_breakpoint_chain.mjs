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
  const executablePath = resolveExecutablePath("hardware breakpoint validation");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-hardware-breakpoint-chain", version: "1.0.0" });
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
      throw new Error("Could not find a sequential instruction for hardware breakpoint validation within 40 step_over operations");
    }

    breakpointAddress = selected.target;

    const breakpoint = await callJson(client, "set_breakpoint", {
      sessionId,
      address: breakpointAddress,
      type: "hardware_execute",
      name: "verify-hardware-breakpoint-chain",
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

    const registersAfter = await callJson(client, "get_registers", {
      sessionId,
      includeSegment: false,
      includeDebug: false,
      includeFpu: false,
    });

    const removed = await callJson(client, "remove_breakpoint", {
      sessionId,
      address: breakpointAddress,
    });
    breakpointAddress = null;

    const listedFinal = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    console.log("=== LOAD ===");
    console.log(JSON.stringify(loaded, null, 2));
    console.log("\n=== SELECTED INSTRUCTION ===");
    console.log(JSON.stringify({ ...selected, searchSteps }, null, 2));
    console.log("\n=== SET HARDWARE BREAKPOINT ===");
    console.log(JSON.stringify(breakpoint, null, 2));
    console.log("\n=== LIST BEFORE ===");
    console.log(JSON.stringify(listedBefore, null, 2));
    console.log("\n=== CONTINUE ===");
    console.log(JSON.stringify(continued, null, 2));
    console.log("\n=== LIST AFTER ===");
    console.log(JSON.stringify(listedAfter, null, 2));
    console.log("\n=== REGISTERS AFTER ===");
    console.log(JSON.stringify(registersAfter, null, 2));
    console.log("\n=== REMOVE BREAKPOINT ===");
    console.log(JSON.stringify(removed, null, 2));
    console.log("\n=== LIST FINAL ===");
    console.log(JSON.stringify(listedFinal, null, 2));

    const beforeHit = listedBefore.breakpoints.find((bp) => bp.address === selected.target);
    const afterHit = listedAfter.breakpoints.find((bp) => bp.address === selected.target);
    const currentIp = registersAfter.general?.eip ?? registersAfter.general?.rip;

    if (!beforeHit) {
      throw new Error(`Hardware breakpoint ${selected.target} not present before continue_execution`);
    }

    if (continued.stopReason !== "breakpoint") {
      throw new Error(`continue_execution returned unexpected stopReason: ${continued.stopReason}`);
    }

    if (continued.currentAddress !== selected.target) {
      throw new Error(
        `continue_execution stopped at ${continued.currentAddress}, expected hardware breakpoint ${selected.target}`
      );
    }

    if (currentIp !== selected.target) {
      throw new Error(`Hardware breakpoint hit ${continued.currentAddress}, but current IP is ${currentIp}`);
    }

    if (!afterHit) {
      throw new Error(`Hardware breakpoint ${selected.target} not present after continue_execution`);
    }

    if ((afterHit.hitCount ?? 0) < 1) {
      throw new Error(`Hardware breakpoint ${selected.target} hitCount was not incremented`);
    }

    if (listedFinal.breakpoints.some((bp) => bp.address === selected.target)) {
      throw new Error(`Hardware breakpoint ${selected.target} still present after remove_breakpoint`);
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