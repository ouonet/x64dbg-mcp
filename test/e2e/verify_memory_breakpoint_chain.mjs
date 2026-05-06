import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveExecutablePath } from "./_target.mjs";

// Defaults to memory_read; set TARGET_BP_TYPE=memory_access to validate access breaks on the same path.
const BREAKPOINT_TYPE = process.env.TARGET_BP_TYPE?.trim() || "memory_read";
const MEMORY_RESTORE = process.env.TARGET_BP_RESTORE?.trim();
const TARGET_BP_COMMAND = process.env.TARGET_BP_COMMAND?.trim();

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

function parseAbsoluteReadOperand(operands) {
  const parts = operands.split(",").map((part) => part.trim());
  for (const part of parts) {
    const match = part.match(/\[([0-9A-Fa-f]+)h\]/i);
    if (match) {
      return {
        source: part,
        watchedAddress: formatAddress(BigInt(`0x${match[1]}`)),
      };
    }
  }
  return null;
}

function parseStackReadOperand(operands) {
  const parts = operands.split(",").map((part) => part.trim());
  if (parts.length < 2) return null;
  const source = parts[1];
  const match = source.match(/\[(eip|rip|eax|ebx|ecx|edx|esi|edi|esp|ebp|rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp)([+-][0-9A-Fa-f]+h?)?\]/i);
  if (!match) return null;

  const register = match[1].toLowerCase();
  const rawOffset = match[2] ?? "+0";
  const sign = rawOffset.startsWith("-") ? -1n : 1n;
  const magnitudeText = rawOffset.slice(1).replace(/h$/i, "") || "0";
  const magnitude = BigInt(`0x${magnitudeText}`);

  return {
    register,
    offset: sign * magnitude,
    source,
  };
}

function normalizeHex(value) {
  return value.toLowerCase();
}

function formatAddress(value) {
  return `0x${value.toString(16).toUpperCase().padStart(16, "0")}`;
}

function breakpointKey(bp) {
  return `${normalizeHex(bp.address)}:${bp.type}`;
}

function memoryModeChar(type) {
  return {
    memory_read: "r",
    memory_write: "w",
    memory_access: "a",
  }[type] ?? null;
}

async function main() {
  const executablePath = resolveExecutablePath(`${BREAKPOINT_TYPE} breakpoint validation`);
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-memory-breakpoint-chain", version: "1.0.0" });
  let sessionId = null;
  let breakpointAddress = null;

  try {
    if (BREAKPOINT_TYPE === "memory_write") {
      throw new Error("Use verify_memory_write_breakpoint_chain.mjs for memory_write validation");
    }

    await client.connect(transport);

    const loaded = await callJson(client, "load_executable", {
      executablePath,
      breakOnEntry: true,
      autoAnalyze: true,
    });
    sessionId = loaded.sessionId;

    let selected = null;
    let registersBefore = null;
    let searchSteps = 0;
    let currentAddress = loaded.entryPoint;
    let callInstruction = null;

    for (; searchSteps < 80; searchSteps += 1) {
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
        break;
      }

      const stepped = await callJson(client, "step_over", {
        sessionId,
        count: 1,
      });
      currentAddress = stepped.address;
    }

    if (!callInstruction) {
      throw new Error("Could not reach a suitable call instruction for memory breakpoint validation within 80 step_over operations");
    }

    await callJson(client, "step_into", {
      sessionId,
      count: 1,
    });

    const steppedOut = await callJson(client, "step_out", {
      sessionId,
    });

    const disassemblyAtTarget = extractText(await client.callTool({
      name: "disassemble",
      arguments: {
        sessionId,
        address: steppedOut.address,
        count: 1,
      },
    }));
    if (!disassemblyAtTarget || disassemblyAtTarget.startsWith("Error:")) {
      throw new Error(disassemblyAtTarget || "disassemble returned empty response at step_out target");
    }

    const instructionsAtTarget = parseDisassembly(disassemblyAtTarget);
    const instruction = instructionsAtTarget[0];
    if (!instruction) {
      throw new Error("Could not parse disassembly output at the step_out target");
    }

    const absoluteRead = parseAbsoluteReadOperand(instruction.operands);
    if (!absoluteRead) {
      throw new Error(`step_out target ${instruction.address} is not an absolute memory read: ${instruction.operands}`);
    }

    registersBefore = await callJson(client, "get_registers", {
      sessionId,
      includeSegment: false,
      includeDebug: false,
      includeFpu: false,
    });

    selected = {
      instruction,
      callInstruction,
      steppedOut,
      readOperand: {
        ...absoluteRead,
        kind: "absolute",
      },
      watchedAddress: absoluteRead.watchedAddress,
    };

    breakpointAddress = selected.watchedAddress;

    const baselineBreakpoints = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    for (const bp of baselineBreakpoints.breakpoints) {
      await callJson(client, "remove_breakpoint", {
        sessionId,
        address: bp.address,
      });
    }

    const armedBaselineBreakpoints = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    let breakpoint;
    const modeChar = memoryModeChar(BREAKPOINT_TYPE);
    if (TARGET_BP_COMMAND) {
      const command = TARGET_BP_COMMAND
        .replaceAll("%ADDR%", breakpointAddress)
        .replaceAll("%MODE%", modeChar ?? "");
      await client.callTool({
        name: "execute_command",
        arguments: {
          sessionId,
          command,
        },
      });
      breakpoint = {
        status: "breakpoint_set",
        address: breakpointAddress,
        bpType: BREAKPOINT_TYPE,
        via: "execute_command",
        command,
      };
    } else if (modeChar && MEMORY_RESTORE) {
      await client.callTool({
        name: "execute_command",
        arguments: {
          sessionId,
          command: `bpm ${breakpointAddress}, ${MEMORY_RESTORE}, ${modeChar}`,
        },
      });
      breakpoint = {
        status: "breakpoint_set",
        address: breakpointAddress,
        bpType: BREAKPOINT_TYPE,
        restore: MEMORY_RESTORE,
        via: "execute_command",
      };
    } else {
      breakpoint = await callJson(client, "set_breakpoint", {
        sessionId,
        address: breakpointAddress,
        type: BREAKPOINT_TYPE,
        name: `verify-${BREAKPOINT_TYPE}-breakpoint-chain`,
      });
    }

    const listedBefore = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    let continued = null;
    let listedAfter = null;
    let registersAfter = null;
    const continueAttempts = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      continued = await callJson(client, "continue_execution", {
        sessionId,
      });

      listedAfter = await callJson(client, "list_breakpoints", {
        sessionId,
      });

      registersAfter = await callJson(client, "get_registers", {
        sessionId,
        includeSegment: false,
        includeDebug: false,
        includeFpu: false,
      });

      continueAttempts.push({
        attempt: attempt + 1,
        continued,
        currentIp: registersAfter.general?.eip ?? registersAfter.general?.rip,
      });

      if (normalizeHex(continued.currentAddress) === normalizeHex(selected.instruction.address)) {
        break;
      }

      if (continued.stopReason === "exited") {
        break;
      }
    }

    if (!continued || !listedAfter || !registersAfter) {
      throw new Error("Memory read breakpoint validation did not execute any continue attempts");
    }

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
    console.log("\n=== SELECTED MEMORY TARGET ===");
    console.log(JSON.stringify({ ...selected, searchSteps }, null, 2));
    console.log("\n=== REGISTERS BEFORE ===");
    console.log(JSON.stringify(registersBefore, null, 2));
    console.log("\n=== BASELINE BREAKPOINTS ===");
    console.log(JSON.stringify(baselineBreakpoints, null, 2));
    console.log("\n=== ARMED BASELINE BREAKPOINTS ===");
    console.log(JSON.stringify(armedBaselineBreakpoints, null, 2));
    console.log("\n=== SET MEMORY BREAKPOINT ===");
    console.log(JSON.stringify(breakpoint, null, 2));
    console.log("\n=== LIST BEFORE ===");
    console.log(JSON.stringify(listedBefore, null, 2));
    console.log("\n=== CONTINUE ===");
    console.log(JSON.stringify(continued, null, 2));
    console.log("\n=== CONTINUE ATTEMPTS ===");
    console.log(JSON.stringify(continueAttempts, null, 2));
    console.log("\n=== LIST AFTER ===");
    console.log(JSON.stringify(listedAfter, null, 2));
    console.log("\n=== REGISTERS AFTER ===");
    console.log(JSON.stringify(registersAfter, null, 2));
    console.log("\n=== REMOVE BREAKPOINT ===");
    console.log(JSON.stringify(removed, null, 2));
    console.log("\n=== LIST FINAL ===");
    console.log(JSON.stringify(listedFinal, null, 2));

    const baselineKeys = new Set(armedBaselineBreakpoints.breakpoints.map(breakpointKey));
    const addedMemoryBreakpoints = listedBefore.breakpoints.filter(
      (bp) => bp.type === 4 && !baselineKeys.has(breakpointKey(bp))
    );
    const beforeHit = addedMemoryBreakpoints[0] ?? null;
    const afterHit = listedAfter.breakpoints.find(
      (bp) => beforeHit && breakpointKey(bp) === breakpointKey(beforeHit)
    );
    const currentIp = registersAfter.general?.eip ?? registersAfter.general?.rip;

    if (!beforeHit) {
      throw new Error(`Could not identify the newly added ${BREAKPOINT_TYPE} breakpoint in list_breakpoints output`);
    }

    if (continued.stopReason !== "breakpoint") {
      throw new Error(`continue_execution returned unexpected stopReason: ${continued.stopReason}`);
    }

    if (normalizeHex(continued.currentAddress) !== normalizeHex(selected.instruction.address)) {
      throw new Error(
        `${BREAKPOINT_TYPE} breakpoint stopped at ${continued.currentAddress}, expected reader instruction ${selected.instruction.address}`
      );
    }

    if (normalizeHex(currentIp) !== normalizeHex(selected.instruction.address)) {
      throw new Error(
        `${BREAKPOINT_TYPE} breakpoint hit at ${continued.currentAddress}, but current IP is ${currentIp}`
      );
    }

    if (afterHit && (afterHit.hitCount ?? 0) < 1) {
      throw new Error(`${BREAKPOINT_TYPE} breakpoint ${beforeHit.address} hitCount was not incremented`);
    }

    if (listedFinal.breakpoints.some(
      (bp) => breakpointKey(bp) === breakpointKey(beforeHit)
    )) {
      throw new Error(`${BREAKPOINT_TYPE} breakpoint ${beforeHit.address} still present after remove_breakpoint`);
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