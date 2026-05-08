import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import type { ServiceCliOptions } from "./router.js";
import {
  SERVICE_NAME,
} from "./types.js";
import {
  serviceEnvFile,
  serviceLogsDir,
  serviceShimPath,
  serviceWrapperDir,
  transcriptDir,
} from "./paths.js";
import { isAdmin, renderPrivilegeError } from "./privilege.js";
import { mergeServiceEnv } from "./env-file.js";
import { buildShim } from "./shim-template.js";
import { writeInstalledRecord, readInstalledRecord } from "./installed-json.js";
import {
  buildElevatedArgs,
  newTranscriptPath,
  runWithTranscript,
  spawnElevatedPowerShell,
  sweepStaleTranscripts,
} from "./elevate.js";

const require = createRequire(import.meta.url);

type NodeWindowsServiceCtor = new (config: NodeWindowsServiceConfig) => NodeWindowsService;
interface NodeWindowsServiceConfig {
  name: string;
  description?: string;
  script: string;
  scriptOptions?: string;
  workingDirectory?: string;
  env?: Array<{ name: string; value: string }>;
  startType?: string;
}
interface NodeWindowsService {
  exists: boolean;
  install(): void;
  on(event: "install", listener: () => void): void;
  on(event: "alreadyinstalled", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "invalidinstallation", listener: () => void): void;
}

function loadNodeWindows(): { Service: NodeWindowsServiceCtor } {
  return require("node-windows") as { Service: NodeWindowsServiceCtor };
}

async function probePortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

function nodeWindowsStartType(t: ServiceCliOptions["startType"]): string {
  switch (t) {
    case "auto":
      return "Automatic";
    case "delayed-auto":
      return "Automatic (Delayed Start)";
    case "manual":
      return "Manual";
  }
}

export async function runInstall(options: ServiceCliOptions): Promise<number> {
  if (process.platform !== "win32") {
    process.stderr.write("✗ Windows service mode is only supported on Windows.\n");
    return 1;
  }

  // Transcript redirection (used by --elevate child).
  if (options.transcript) {
    const stream = fs.createWriteStream(options.transcript, { flags: "a" });
    process.stdout.write = ((c: string | Buffer) => stream.write(c)) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Buffer) => stream.write(c)) as typeof process.stderr.write;
  }

  sweepStaleTranscripts(transcriptDir(), 60 * 60 * 1000);

  if (!isAdmin()) {
    if (options.elevate) {
      const exePath = process.execPath; // node.exe
      const cliEntry = process.argv[1] ?? require.resolve("x64dbg-mcp/dist/server.js");
      const transcript = newTranscriptPath();
      // buildElevatedArgs strips --elevate and replaces it with --transcript <path>.
      const args = buildElevatedArgs(
        ["service", "install", "--port", String(options.port), "--host", options.host, "--display-name", options.displayName, "--start", options.startType, "--elevate"],
        transcript
      );
      // Prepend cliEntry so PowerShell -Verb RunAs spawns "node.exe <cliEntry> service install ..."
      const exitCode = await runWithTranscript({
        transcriptPath: transcript,
        write: (chunk) => process.stdout.write(chunk),
        spawn: () => spawnElevatedPowerShell({ exePath, args: [cliEntry, ...args] }),
      });
      return exitCode;
    }
    process.stderr.write(renderPrivilegeError(`service install --port ${options.port}`));
    return 2;
  }

  // Conflict checks.
  if (readInstalledRecord() !== null) {
    process.stderr.write(`✗ Service '${SERVICE_NAME}' is already installed. Run 'service uninstall' first.\n`);
    return 3;
  }
  const { Service } = loadNodeWindows();
  const probe = new Service({
    name: SERVICE_NAME,
    script: serviceShimPath(),
  });
  if (probe.exists) {
    process.stderr.write(`✗ Service '${SERVICE_NAME}' is already registered with SCM. Run 'service uninstall' first.\n`);
    return 3;
  }

  // Port availability pre-flight.
  if (!(await probePortAvailable(options.host, options.port))) {
    process.stderr.write(`✗ Port ${options.port} is already in use on ${options.host}.\n`);
    return 4;
  }

  // Resolve installPath. Prefer process.argv[1] (works for both npm-installed bin
  // shim and direct `node dist/server.js`), fall back to module resolution.
  let installPath: string;
  let packageVersion: string;
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1) && argv1.endsWith("server.js")) {
    installPath = path.resolve(argv1);
  } else {
    try {
      installPath = require.resolve("x64dbg-mcp/dist/server.js");
    } catch {
      process.stderr.write("✗ Cannot locate dist/server.js. Run 'npm run build' first or reinstall the package.\n");
      return 1;
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(installPath), "..", "package.json"), "utf8")) as { version: string };
    packageVersion = pkg.version;
  } catch {
    packageVersion = "unknown";
  }

  // Prepare directories.
  fs.mkdirSync(serviceWrapperDir(), { recursive: true });
  fs.mkdirSync(serviceLogsDir(), { recursive: true });

  // Write shim.
  fs.writeFileSync(serviceShimPath(), buildShim(installPath), "utf8");

  // Seed .env.
  mergeServiceEnv({ host: options.host, port: options.port });

  // Register service.
  const svc = new Service({
    name: SERVICE_NAME,
    description: options.displayName,
    script: serviceShimPath(),
    scriptOptions: `--transport streamable-http --host "${options.host}" --port ${options.port}`,
    workingDirectory: serviceWrapperDir(),
    env: [{ name: "X64DBG_MCP_CONFIG", value: serviceEnvFile() }],
    startType: nodeWindowsStartType(options.startType),
  });

  return await new Promise<number>((resolve) => {
    svc.on("install", () => {
      writeInstalledRecord({
        installPath,
        port: options.port,
        host: options.host,
        version: packageVersion,
        installedAt: new Date().toISOString(),
        displayName: options.displayName,
        startType: options.startType,
      });
      process.stdout.write(`✓ Service '${SERVICE_NAME}' installed.\n`);
      process.stdout.write(`  Endpoint:  http://${options.host}:${options.port}/mcp\n`);
      process.stdout.write(`  Logs:      ${serviceLogsDir()}\n`);
      process.stdout.write(`  Config:    ${serviceEnvFile()}\n`);
      process.stdout.write(`  Run 'x64dbg-mcp service start' to start it now.\n`);
      resolve(0);
    });
    svc.on("alreadyinstalled", () => {
      process.stderr.write(`✗ Service '${SERVICE_NAME}' already installed (race condition).\n`);
      resolve(3);
    });
    svc.on("invalidinstallation", () => {
      process.stderr.write(`✗ node-windows reported an invalid installation. Inspect ${serviceWrapperDir()} for stale files.\n`);
      resolve(1);
    });
    svc.on("error", (err) => {
      process.stderr.write(`✗ Service install failed: ${err.message}\n`);
      resolve(1);
    });
    svc.install();
  });
}
