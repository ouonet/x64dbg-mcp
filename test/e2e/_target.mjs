import { execFileSync } from "child_process";
import fs from "fs";

function runPowerShell(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  }).trim();
}

export function resolveExecutablePath(purpose) {
  const exePath = process.env.TARGET_EXE?.trim();
  if (!exePath) {
    throw new Error(
      `Set TARGET_EXE to an executable path for ${purpose}. This repo does not bundle machine-specific defaults.`
    );
  }
  if (!fs.existsSync(exePath)) {
    throw new Error(`Executable not found for ${purpose}: ${exePath}`);
  }
  return exePath;
}

export function resolvePidFromEnv(purpose, { optional = false } = {}) {
  const envPid = process.env.TARGET_PID?.trim();
  if (envPid) {
    const parsed = Number(envPid);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid TARGET_PID: ${process.env.TARGET_PID}`);
    }
    try {
      runPowerShell(`(Get-Process -Id ${parsed} -ErrorAction Stop | Select-Object -ExpandProperty Id)`);
      return parsed;
    } catch {
      throw new Error(`TARGET_PID does not refer to a live process: ${parsed}`);
    }
  }

  const processName = process.env.TARGET_PROCESS_NAME?.trim();
  if (processName) {
    const output = runPowerShell(
      `(Get-Process -Name '${processName}' -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Id)`
    );
    const pid = Number(output);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Could not resolve a live PID for TARGET_PROCESS_NAME=${processName}`);
    }
    return pid;
  }

  if (optional) {
    return null;
  }

  throw new Error(
    `Set TARGET_PID or TARGET_PROCESS_NAME for ${purpose}. This repo does not assume a machine-specific process name.`
  );
}