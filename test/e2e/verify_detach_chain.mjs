import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";

function resolveTarget() {
  const rawPid = process.env.TARGET_PID?.trim();
  if (rawPid) {
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Invalid TARGET_PID: ${process.env.TARGET_PID}`);
    }
    return { mode: "attach", pid };
  }

  const executablePath = process.env.TARGET_EXE?.trim();
  if (executablePath) {
    return {
      mode: "load",
      executablePath,
      commandLineArgs: process.env.TARGET_ARGS?.trim() ?? "",
    };
  }

  throw new Error("Set TARGET_PID for attach validation or TARGET_EXE for load validation.");
}

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

function assertProcessAlive(pid) {
  const script = `
    $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
    if ($null -eq $p) { exit 1 }
    Write-Output $p.Id
  `;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
  if (Number(output) !== pid) {
    throw new Error(`Expected PID ${pid} to still be alive, got ${output || "<none>"}`);
  }
}

async function main() {
  const target = resolveTarget();
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/server.js"],
    env: process.env,
  });

  const client = new Client({ name: "verify-detach-chain", version: "1.0.0" });
  let sessionId = null;

  try {
    await client.connect(transport);

    let startResult;
    let pid;
    if (target.mode === "attach") {
      const attach = await client.callTool({
        name: "attach_to_process",
        arguments: {
          pid: target.pid,
          breakOnEntry: true,
          autoAnalyze: true,
        },
      });
      startResult = parseJsonText(attach);
      pid = target.pid;
    } else {
      const load = await client.callTool({
        name: "load_executable",
        arguments: {
          executablePath: target.executablePath,
          commandLineArgs: target.commandLineArgs,
          breakOnEntry: true,
          autoAnalyze: true,
        },
      });
      startResult = parseJsonText(load);
      pid = startResult.pid;
    }
    sessionId = startResult.sessionId;

    const detach = await client.callTool({
      name: "detach_session",
      arguments: { sessionId },
    });
    const detachResult = parseJsonText(detach);

    const sessions = await client.callTool({
      name: "list_sessions",
      arguments: {},
    });
    const sessionsResult = parseJsonText(sessions);
    if (!Array.isArray(sessionsResult) || sessionsResult.length !== 0) {
      throw new Error(`Expected no active sessions after detach, got: ${JSON.stringify(sessionsResult)}`);
    }

    assertProcessAlive(pid);

    console.log(target.mode === "attach" ? "=== ATTACH ===" : "=== LOAD ===");
    console.log(JSON.stringify(startResult, null, 2));
    console.log("\n=== DETACH ===");
    console.log(JSON.stringify(detachResult, null, 2));
    console.log("\n=== VERIFY ===");
    console.log(JSON.stringify({ pid, pidAlive: true, activeSessions: 0, mode: target.mode }, null, 2));
  } finally {
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