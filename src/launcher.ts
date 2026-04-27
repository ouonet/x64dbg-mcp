/**
 * Debugger launcher — auto-detect PE architecture and spawn x32dbg / x64dbg.
 *
 * Reads the PE header to determine if a target is 32-bit or 64-bit,
 * launches the correct debugger, and waits for the bridge plugin to
 * become reachable over TCP.
 */

import { spawn, ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { config } from "./config.js";
import { logger } from "./logger.js";

const BRIDGE_POLL_INTERVAL_MS = 500;
const BRIDGE_POLL_TIMEOUT_MS = 30_000;

/** PE machine types */
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

let debuggerProcess: ChildProcess | null = null;

/**
 * Detect PE architecture by reading the PE header from disk.
 * Returns "x86" or "x64", or throws if the file is not a valid PE.
 */
export function detectPEArchitecture(
  exePath: string
): "x86" | "x64" {
  const fd = fs.openSync(exePath, "r");
  try {
    // Read DOS header (first 64 bytes)
    const dosHeader = Buffer.alloc(64);
    fs.readSync(fd, dosHeader, 0, 64, 0);

    if (dosHeader.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Not a valid PE file (bad MZ signature): ${exePath}`);
    }

    const peOffset = dosHeader.readUInt32LE(0x3c);

    // Read PE signature (4 bytes) + COFF header (20 bytes)
    const peHeader = Buffer.alloc(24);
    fs.readSync(fd, peHeader, 0, 24, peOffset);

    if (peHeader.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Not a valid PE file (bad PE signature): ${exePath}`);
    }

    const machine = peHeader.readUInt16LE(4);

    switch (machine) {
      case IMAGE_FILE_MACHINE_I386:
        return "x86";
      case IMAGE_FILE_MACHINE_AMD64:
        return "x64";
      default:
        throw new Error(
          `Unsupported PE machine type 0x${machine.toString(16)}: ${exePath}`
        );
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Resolve the path to x32dbg.exe or x64dbg.exe based on the
 * configured x64dbg installation directory.
 */
export function resolveDebuggerExe(arch: "x86" | "x64"): string {
  const base = config.x64dbgPath;

  // Standard x64dbg layout: release/x32/x32dbg.exe, release/x64/x64dbg.exe
  const candidates = arch === "x86"
    ? [
        path.join(base, "release", "x32", "x32dbg.exe"),
        path.join(base, "x32", "x32dbg.exe"),
        path.join(base, "x32dbg.exe"),
      ]
    : [
        path.join(base, "release", "x64", "x64dbg.exe"),
        path.join(base, "x64", "x64dbg.exe"),
        path.join(base, "x64dbg.exe"),
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    `Could not find ${arch === "x86" ? "x32dbg" : "x64dbg"}.exe ` +
      `in ${base}. Checked:\n  ${candidates.join("\n  ")}`
  );
}

/**
 * Quick non-blocking probe: returns true if the bridge port accepts a TCP
 * connection within 200 ms. Used to detect a running x64dbg before spawning.
 */
async function probeBridge(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(200);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error",   () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

/**
 * Wait for the bridge TCP port to become reachable.
 */
async function waitForBridge(
  host: string,
  port: number,
  timeoutMs = BRIDGE_POLL_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(BRIDGE_POLL_INTERVAL_MS);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
      sock.once("timeout", () => {
        sock.destroy();
        resolve(false);
      });
      sock.connect(port, host);
    });

    if (reachable) {
      logger.info("Bridge port is reachable");
      return;
    }
    // No extra sleep here: the socket timeout (BRIDGE_POLL_INTERVAL_MS) already
    // provides the inter-probe delay, avoiding a doubled wait per iteration.
  }

  throw new Error(
    `Bridge did not become reachable on ${host}:${port} within ${timeoutMs}ms`
  );
}

/**
 * Launch x64dbg (or x32dbg) with the given executable and wait for
 * the bridge plugin to start accepting TCP connections.
 *
 * @returns The detected architecture.
 */
export async function launchDebugger(
  targetExe: string
): Promise<"x86" | "x64"> {
  if (!fs.existsSync(targetExe)) {
    throw new Error(`Target executable not found: ${targetExe}`);
  }

  const arch = detectPEArchitecture(targetExe);

  // If x64dbg is already running with bridge open, reuse it — skip spawn.
  const alreadyRunning = await probeBridge(config.bridgeHost, config.bridgePort);
  if (alreadyRunning) {
    logger.info("Bridge already reachable — reusing existing x64dbg instance");
    return arch;
  }

  const dbgExe = resolveDebuggerExe(arch);

  logger.info(`Detected ${arch} PE, launching ${path.basename(dbgExe)}`);
  logger.info(`Debugger: ${dbgExe}`);
  logger.info(`Target:   ${targetExe}`);

  // Launch x64dbg without a target — the MCP bridge will load the executable
  // via the debug.load command after the bridge is ready. Passing the target
  // on the command line causes a race: x64dbg starts loading it before the
  // bridge plugin is ready to handle debug.load, leading to conflicts.
  const args: string[] = [];

  // Kill previous debugger process if still alive
  if (debuggerProcess && debuggerProcess.exitCode === null) {
    logger.warn("Killing previous debugger process");
    debuggerProcess.kill();
    debuggerProcess = null;
  }

  debuggerProcess = spawn(dbgExe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });

  debuggerProcess.unref();

  debuggerProcess.on("error", (err: Error) => {
    logger.error(`Debugger process error: ${err.message}`);
  });

  debuggerProcess.on("exit", (code: number | null) => {
    logger.info(`Debugger process exited (code ${code})`);
    debuggerProcess = null;
  });

  logger.info(
    `Debugger spawned (pid=${debuggerProcess.pid}), waiting for bridge...`
  );

  // Wait for bridge plugin to open its TCP port
  await waitForBridge(config.bridgeHost, config.bridgePort);

  return arch;
}

/**
 * Kill the debugger process if it is still running.
 *
 * Set KEEP_DEBUGGER=1 in the environment to skip the kill — useful when
 * the user wants to preserve an in-progress x64dbg analysis session after
 * the MCP host disconnects.
 */
export function killDebugger(): void {
  if (process.env.KEEP_DEBUGGER === "1") {
    logger.info("KEEP_DEBUGGER=1 — skipping debugger kill");
    return;
  }
  if (debuggerProcess && debuggerProcess.exitCode === null) {
    logger.info("Killing debugger process");
    debuggerProcess.kill();
    debuggerProcess = null;
  }
}

/**
 * Returns true if a debugger process was launched by us and is still running.
 */
export function isDebuggerRunning(): boolean {
  return debuggerProcess !== null && debuggerProcess.exitCode === null;
}
