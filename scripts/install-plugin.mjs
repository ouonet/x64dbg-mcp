#!/usr/bin/env node
/**
 * install-plugin — cross-platform entry point for plugin installation.
 *
 * On Windows: delegates to install-plugin.ps1 via PowerShell.
 * On other platforms: prints a notice and exits 0 (plugin only runs on Windows).
 */

import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PS1  = path.join(ROOT, "scripts", "install-plugin.ps1");

if (process.platform !== "win32") {
  console.log(
    "[install-plugin] Skipped: the x64dbg plugin only runs on Windows.\n" +
    "  If you are cross-compiling or setting up CI on Linux, build the C loader\n" +
    "  manually with CMake and copy the artifacts to your Windows machine."
  );
  process.exit(0);
}

// Forward all CLI arguments to the PowerShell script unchanged.
const args = process.argv.slice(2);
const result = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", PS1, ...args],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);
