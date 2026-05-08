import { spawnSync } from "node:child_process";

export function isAdmin(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const result = spawnSync("fltmc.exe", [], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function renderPrivilegeError(suggestedArgs: string): string {
  return [
    "This command requires administrator privileges.",
    "",
    "Please open PowerShell as Administrator and re-run:",
    "",
    `    x64dbg-mcp ${suggestedArgs}`,
    "",
    "Or pass --elevate to attempt automatic elevation:",
    "",
    `    x64dbg-mcp ${suggestedArgs} --elevate`,
    "",
  ].join("\n");
}
