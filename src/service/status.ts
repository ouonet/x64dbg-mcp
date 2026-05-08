import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SERVICE_NAME, type ScmQueryResult, type ServiceState, type StartType, type StatusViewModel } from "./types.js";
import { readInstalledRecord } from "./installed-json.js";
import { checkHealth } from "./health-check.js";
import { formatStatus } from "./status-formatter.js";

function parseScmQueryEx(stdout: string): { state: ServiceState; pid?: number } | null {
  const stateMatch = stdout.match(/STATE\s+:\s+\d+\s+(\w+)/);
  if (!stateMatch) return null;
  const stateRaw = stateMatch[1].toUpperCase();
  const map: Record<string, ServiceState> = {
    RUNNING: "RUNNING",
    STOPPED: "STOPPED",
    START_PENDING: "START_PENDING",
    STOP_PENDING: "STOP_PENDING",
    PAUSED: "PAUSED",
  };
  const state = map[stateRaw] ?? "UNKNOWN";
  const pidMatch = stdout.match(/PID\s+:\s+(\d+)/);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : undefined;
  return pid !== undefined ? { state, pid } : { state };
}

function parseScmQc(stdout: string): { startType: StartType; identityAccount: string } {
  const startTypeMatch = stdout.match(/START_TYPE\s+:\s+\d+\s+([\w_\(\)\s]+)/);
  let startType: StartType = "manual";
  if (startTypeMatch) {
    const raw = startTypeMatch[1].trim();
    if (/AUTO_START.*DELAYED/i.test(raw)) startType = "delayed-auto";
    else if (/AUTO_START/i.test(raw)) startType = "auto";
    else if (/DEMAND_START/i.test(raw)) startType = "manual";
  }
  const accountMatch = stdout.match(/SERVICE_START_NAME\s+:\s+(.+)/);
  const identityAccount = accountMatch ? accountMatch[1].trim() : "Unknown";
  return { startType, identityAccount };
}

function queryScm(): ScmQueryResult {
  const queryex = spawnSync("sc.exe", ["queryex", SERVICE_NAME], { encoding: "utf8", windowsHide: true });
  if (queryex.status !== 0) {
    return { installed: false, state: "STOPPED", identityAccount: "Unknown", scmStartType: "manual" };
  }
  const parsed = parseScmQueryEx(queryex.stdout);
  if (!parsed) {
    return { installed: false, state: "UNKNOWN", identityAccount: "Unknown", scmStartType: "manual" };
  }

  const qc = spawnSync("sc.exe", ["qc", SERVICE_NAME], { encoding: "utf8", windowsHide: true });
  let extras = { startType: "manual" as StartType, identityAccount: "Unknown" };
  if (qc.status === 0) extras = parseScmQc(qc.stdout);

  return {
    installed: true,
    state: parsed.state,
    pid: parsed.pid,
    identityAccount: extras.identityAccount,
    scmStartType: extras.startType,
  };
}

function readPackageVersion(installPath: string): string | undefined {
  try {
    const pkgPath = path.resolve(installPath, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export async function runStatus(): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("✗ Windows service mode is only supported on Windows.\n");
    return 1;
  }

  const record = readInstalledRecord();
  const scm = queryScm();

  if (!scm.installed && !record) {
    const vm: StatusViewModel = { name: SERVICE_NAME, installed: false };
    process.stdout.write(formatStatus(vm));
    return 0;
  }

  let health: StatusViewModel["health"] | undefined;
  let endpoint: string | undefined;
  if (scm.state === "RUNNING" && record) {
    endpoint = `http://${record.host}:${record.port}/mcp`;
    health = await checkHealth({ host: record.host, port: record.port, timeoutMs: 5000 });
  }

  const packageVersion = record ? readPackageVersion(record.installPath) ?? record.version : undefined;

  const vm: StatusViewModel = {
    name: SERVICE_NAME,
    installed: true,
    scm,
    record: record ?? undefined,
    health,
    endpoint,
    packageVersion,
  };
  process.stdout.write(formatStatus(vm));
  return 0;
}
