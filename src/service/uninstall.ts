import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import type { ServiceCliOptions } from "./router.js";
import { SERVICE_NAME } from "./types.js";
import {
  serviceShimPath,
  serviceWrapperDir,
  transcriptDir,
} from "./paths.js";
import { isAdmin, renderPrivilegeError } from "./privilege.js";
import { readInstalledRecord, removeInstalledRecord } from "./installed-json.js";
import {
  buildElevatedArgs,
  newTranscriptPath,
  runWithTranscript,
  spawnElevatedPowerShell,
  sweepStaleTranscripts,
} from "./elevate.js";

const require = createRequire(import.meta.url);

interface NodeWindowsService {
  exists: boolean;
  uninstall(): void;
  on(event: "uninstall", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}
interface NodeWindowsServiceConfig {
  name: string;
  script: string;
}
type NodeWindowsServiceCtor = new (config: NodeWindowsServiceConfig) => NodeWindowsService;

function loadNodeWindows(): { Service: NodeWindowsServiceCtor } {
  return require("node-windows");
}

function fallbackScDelete(): boolean {
  const result = spawnSync("sc.exe", ["delete", SERVICE_NAME], { stdio: "ignore", windowsHide: true });
  return result.status === 0;
}

function bestEffortCleanup(): void {
  if (fs.existsSync(serviceWrapperDir())) {
    const entries = fs.readdirSync(serviceWrapperDir());
    for (const entry of entries) {
      if (entry === ".env") continue; // never auto-delete user-editable config; .env is in serviceRootDir, not wrapperDir
      try {
        fs.rmSync(`${serviceWrapperDir()}\\${entry}`, { recursive: true, force: true });
      } catch {
        // Ignore individual deletion failures.
      }
    }
  }
  removeInstalledRecord();
}

export async function runUninstall(options: ServiceCliOptions): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("✗ Windows service mode is only supported on Windows.\n");
    return 1;
  }

  if (options.transcript) {
    const stream = fs.createWriteStream(options.transcript, { flags: "a" });
    process.stdout.write = ((c: string | Buffer) => stream.write(c)) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Buffer) => stream.write(c)) as typeof process.stderr.write;
  }

  sweepStaleTranscripts(transcriptDir(), 60 * 60 * 1000);

  if (!isAdmin()) {
    if (options.elevate) {
      const exePath = process.execPath;
      const cliEntry = process.argv[1] ?? require.resolve("x64dbg-mcp/dist/server.js");
      const transcript = newTranscriptPath();
      // buildElevatedArgs strips --elevate and replaces it with --transcript <path>.
      const args = buildElevatedArgs(["service", "uninstall", "--elevate"], transcript);
      const exitCode = await runWithTranscript({
        transcriptPath: transcript,
        write: (chunk) => process.stdout.write(chunk),
        spawn: () => spawnElevatedPowerShell({ exePath, args: [cliEntry, ...args] }),
      });
      return exitCode;
    }
    process.stderr.write(renderPrivilegeError("service uninstall"));
    return 2;
  }

  const record = readInstalledRecord();
  const { Service } = loadNodeWindows();
  // node-windows exposes .exists synchronously; discard after probe.
  const probe = new Service({ name: SERVICE_NAME, script: serviceShimPath() });

  if (!probe.exists && !record) {
    process.stderr.write(`✗ Service '${SERVICE_NAME}' is not installed.\n`);
    return 3;
  }

  if (!probe.exists && record) {
    // Stale record: nothing to delete via SCM, just clean up files.
    bestEffortCleanup();
    process.stdout.write(`✓ Stale install record cleaned up.\n`);
    return 0;
  }

  const svc = new Service({ name: SERVICE_NAME, script: serviceShimPath() });
  return await new Promise<number>((resolve) => {
    let resolved = false;
    const finish = (code: number): void => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };

    svc.on("uninstall", () => {
      bestEffortCleanup();
      process.stdout.write(`✓ Service '${SERVICE_NAME}' uninstalled.\n`);
      finish(0);
    });

    svc.on("error", (err) => {
      // Fallback: try sc.exe delete.
      process.stderr.write(`node-windows uninstall failed: ${err.message}\n`);
      if (fallbackScDelete()) {
        bestEffortCleanup();
        process.stdout.write(`✓ Service '${SERVICE_NAME}' uninstalled via fallback.\n`);
        finish(0);
      } else {
        finish(1);
      }
    });

    svc.uninstall();
  });
}
