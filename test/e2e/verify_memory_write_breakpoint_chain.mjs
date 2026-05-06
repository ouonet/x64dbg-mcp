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

function parseStackWriteOperand(operands) {
  const [dest] = operands.split(",").map((part) => part.trim());
  if (!dest) return null;

  const match = dest.match(/\[(eip|rip|eax|ebx|ecx|edx|esi|edi|esp|ebp|rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp)([+-][0-9A-Fa-f]+h?)?\]/i);
  if (!match) return null;

  const register = match[1].toLowerCase();
  const rawOffset = match[2] ?? "+0";
  const sign = rawOffset.startsWith("-") ? -1n : 1n;
  const magnitudeText = rawOffset.slice(1).replace(/h$/i, "") || "0";
  const magnitude = BigInt(`0x${magnitudeText}`);

  return {
    register,
    offset: sign * magnitude,
    destination: dest,
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

async function main() {
  const executablePath = resolveExecutablePath("memory_write breakpoint validation");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-memory-write-breakpoint-chain", version: "1.0.0" });
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
    let registersBefore = null;
    let searchSteps = 0;
    let currentAddress = loaded.entryPoint;

    for (; searchSteps < 40; searchSteps += 1) {
      const disassemblyText = extractText(await client.callTool({
        name: "disassemble",
        arguments: {
          sessionId,
          address: currentAddress,
          count: 1,
        },
      }));
      if (!disassemblyText || disassemblyText.startsWith("Error:")) {
        throw new Error(disassemblyText || "disassemble returned empty response");
      }

      const instructions = parseDisassembly(disassemblyText);
      const instruction = instructions[0];
      if (!instruction) {
        throw new Error("Could not parse disassembly output while searching for a memory write instruction");
      }

      const stackWrite = parseStackWriteOperand(instruction.operands);
      if (instruction.mnemonic === "mov" && stackWrite) {
        registersBefore = await callJson(client, "get_registers", {
          sessionId,
          includeSegment: false,
          includeDebug: false,
          includeFpu: false,
        });
        const baseValue = registersBefore.general?.[stackWrite.register];
        if (!baseValue) {
          throw new Error(`Register ${stackWrite.register} not present in get_registers output`);
        }
        const watchedAddress = BigInt(baseValue) + stackWrite.offset;
        selected = {
          instruction,
          stackWrite: {
            ...stackWrite,
            offset: stackWrite.offset.toString(),
          },
          watchedAddress: formatAddress(watchedAddress),
        };
        break;
      }

      const stepped = await callJson(client, "step_over", {
        sessionId,
        count: 1,
      });
      currentAddress = stepped.address;
    }

    if (!selected || !registersBefore) {
      throw new Error("Could not find a suitable stack write instruction for memory_write breakpoint validation within 40 step_over operations");
    }

    breakpointAddress = selected.watchedAddress;

    const baselineBreakpoints = await callJson(client, "list_breakpoints", {
      sessionId,
    });

    const breakpoint = await callJson(client, "set_breakpoint", {
      sessionId,
      address: breakpointAddress,
      type: "memory_write",
      name: "verify-memory_write-breakpoint-chain",
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
    console.log("\n=== SELECTED MEMORY WRITE ===");
    console.log(JSON.stringify({ ...selected, searchSteps }, null, 2));
    console.log("\n=== REGISTERS BEFORE ===");
    console.log(JSON.stringify(registersBefore, null, 2));
    console.log("\n=== BASELINE BREAKPOINTS ===");
    console.log(JSON.stringify(baselineBreakpoints, null, 2));
    console.log("\n=== SET MEMORY BREAKPOINT ===");
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

    const baselineKeys = new Set(baselineBreakpoints.breakpoints.map(breakpointKey));
    const addedMemoryBreakpoints = listedBefore.breakpoints.filter(
      (bp) => bp.type === 4 && !baselineKeys.has(breakpointKey(bp))
    );
    const beforeHit = addedMemoryBreakpoints[0] ?? null;
    const afterHit = listedAfter.breakpoints.find(
      (bp) => beforeHit && breakpointKey(bp) === breakpointKey(beforeHit)
    );
    const currentIp = registersAfter.general?.eip ?? registersAfter.general?.rip;

    if (!beforeHit) {
      throw new Error("Could not identify the newly added memory breakpoint in list_breakpoints output");
    }

    if (continued.stopReason !== "breakpoint") {
      throw new Error(`continue_execution returned unexpected stopReason: ${continued.stopReason}`);
    }

    if (normalizeHex(continued.currentAddress) !== normalizeHex(selected.instruction.address)) {
      throw new Error(
        `memory_write breakpoint stopped at ${continued.currentAddress}, expected writer instruction ${selected.instruction.address}`
      );
    }

    if (normalizeHex(currentIp) !== normalizeHex(selected.instruction.address)) {
      throw new Error(
        `memory_write breakpoint hit at ${continued.currentAddress}, but current IP is ${currentIp}`
      );
    }

    if (afterHit && (afterHit.hitCount ?? 0) < 1) {
      throw new Error(`memory_write breakpoint ${beforeHit.address} hitCount was not incremented`);
    }

    if (listedFinal.breakpoints.some(
      (bp) => breakpointKey(bp) === breakpointKey(beforeHit)
    )) {
      throw new Error(`memory_write breakpoint ${beforeHit.address} still present after remove_breakpoint`);
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