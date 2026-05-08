import fs from "node:fs";
import { createRequire } from "node:module";
import type { ServiceCliOptions } from "./router.js";
import { SERVICE_NAME } from "./types.js";
import { serviceShimPath, transcriptDir } from "./paths.js";
import { isAdmin, renderPrivilegeError } from "./privilege.js";
import { readInstalledRecord } from "./installed-json.js";
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
  start(): void;
  stop(): void;
  on(event: "start", listener: () => void): void;
  on(event: "stop", listener: () => void): void;
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

type Action = "start" | "stop" | "restart";

async function performStart(svc: NodeWindowsService): Promise<number> {
  return new Promise<number>((resolve) => {
    svc.on("start", () => {
      process.stdout.write(`✓ Service '${SERVICE_NAME}' started.\n`);
      resolve(0);
    });
    svc.on("error", (err) => {
      process.stderr.write(`✗ Service start failed: ${err.message}\n`);
      resolve(1);
    });
    svc.start();
  });
}

async function performStop(svc: NodeWindowsService): Promise<number> {
  return new Promise<number>((resolve) => {
    svc.on("stop", () => {
      process.stdout.write(`✓ Service '${SERVICE_NAME}' stopped.\n`);
      resolve(0);
    });
    svc.on("error", (err) => {
      process.stderr.write(`✗ Service stop failed: ${err.message}\n`);
      resolve(1);
    });
    svc.stop();
  });
}

export async function runLifecycle(action: Action, options: ServiceCliOptions): Promise<number> {
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
      const args = buildElevatedArgs(["service", action, "--elevate"], transcript);
      const exitCode = await runWithTranscript({
        transcriptPath: transcript,
        write: (chunk) => process.stdout.write(chunk),
        spawn: () => spawnElevatedPowerShell({ exePath, args: [cliEntry, ...args] }),
      });
      return exitCode;
    }
    process.stderr.write(renderPrivilegeError(`service ${action}`));
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

  if (action === "start") {
    const svc = new Service({ name: SERVICE_NAME, script: serviceShimPath() });
    return performStart(svc);
  }
  if (action === "stop") {
    const svc = new Service({ name: SERVICE_NAME, script: serviceShimPath() });
    return performStop(svc);
  }

  // restart = stop then start. Build fresh Service instances for each phase to clear listeners.
  const svcStop = new Service({ name: SERVICE_NAME, script: serviceShimPath() });
  const stopCode = await performStop(svcStop);
  if (stopCode !== 0) {
    // Continue to start even if stop failed (service may have already been stopped).
    process.stdout.write("(continuing to start despite stop error)\n");
  }
  const svcStart = new Service({ name: SERVICE_NAME, script: serviceShimPath() });
  return performStart(svcStart);
}
