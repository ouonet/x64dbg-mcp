import type { StartType, StatusViewModel } from "./types.js";

function startTypeLabel(t: StartType): string {
  switch (t) {
    case "auto":
      return "Automatic";
    case "delayed-auto":
      return "Automatic (Delayed Start)";
    case "manual":
      return "Manual";
  }
}

export function formatStatus(vm: StatusViewModel): string {
  if (!vm.installed) {
    return [
      `Service:     ${vm.name}  (not installed)`,
      "",
      "Install with:",
      "    x64dbg-mcp service install --port 3602",
      "",
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`Service:     ${vm.name}`);

  if (vm.scm) {
    const meta: string[] = [];
    meta.push(startTypeLabel(vm.scm.scmStartType));
    if (vm.scm.startedAt) meta.push(`started ${vm.scm.startedAt}`);
    if (meta.length > 0) {
      lines.push(`State:       ${vm.scm.state}                (${meta.join(", ")})`);
    } else {
      lines.push(`State:       ${vm.scm.state}`);
    }
    if (vm.scm.state === "RUNNING") {
      if (typeof vm.scm.pid === "number") lines.push(`PID:         ${vm.scm.pid}`);
      if (vm.endpoint) lines.push(`Endpoint:    ${vm.endpoint}`);
      if (vm.health) {
        if (vm.health.ok) {
          lines.push(`Health:      OK (initialize ${vm.health.durationMs ?? 0}ms)`);
        } else {
          lines.push(`Health:      FAILED (${vm.health.reason ?? "unknown"})`);
        }
      }
    }
    lines.push(`Identity:    ${vm.scm.identityAccount}`);
  }

  if (vm.record) {
    lines.push(`Logs:        ${process.env.PROGRAMDATA ?? "C:\\ProgramData"}\\x64dbg-mcp\\logs\\`);
    lines.push(`Installed:   ${vm.record.installedAt.slice(0, 10)} from ${vm.record.installPath}`);
  }

  if (vm.packageVersion) {
    lines.push(`Version:     ${vm.packageVersion}`);
  }

  lines.push("");
  return lines.join("\n");
}
