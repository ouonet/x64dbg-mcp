import { spawnSync } from "node:child_process";
import path from "node:path";
import { isAdmin } from "../../../src/service/privilege.js";

export function shouldSkip(): { skip: boolean; reason?: string } {
  if (process.platform !== "win32") return { skip: true, reason: "windows-only" };
  if (!isAdmin()) return { skip: true, reason: "requires admin" };
  return { skip: false };
}

export function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const cliPath = path.resolve(process.cwd(), "dist", "server.js");
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function ensureUninstalled(): void {
  runCli(["service", "uninstall"]);
}
