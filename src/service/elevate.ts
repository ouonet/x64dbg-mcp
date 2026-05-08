import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { transcriptDir, transcriptGlobPattern } from "./paths.js";

export interface ElevatedSpawnResult {
  exitCode: number;
}

export interface RunWithTranscriptOptions {
  transcriptPath: string;
  spawn: () => Promise<ElevatedSpawnResult>;
  write: (chunk: string) => void;
  pollIntervalMs?: number;
}

export function buildElevatedArgs(originalArgs: string[], transcriptPath: string): string[] {
  const filtered = originalArgs.filter((a) => a !== "--elevate");
  return [...filtered, "--transcript", transcriptPath];
}

export async function runWithTranscript(options: RunWithTranscriptOptions): Promise<number> {
  const interval = options.pollIntervalMs ?? 250;
  let offset = 0;

  const tick = (): void => {
    if (!fs.existsSync(options.transcriptPath)) return;
    try {
      const stat = fs.statSync(options.transcriptPath);
      if (stat.size <= offset) return;
      const fd = fs.openSync(options.transcriptPath, "r");
      try {
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        offset = stat.size;
        options.write(buf.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Ignore transient read errors during polling.
    }
  };

  const timer = setInterval(tick, interval);

  try {
    const result = await options.spawn();
    // One final read to drain any remaining content.
    tick();
    return result.exitCode;
  } finally {
    clearInterval(timer);
    if (fs.existsSync(options.transcriptPath)) {
      try {
        fs.rmSync(options.transcriptPath, { force: true });
      } catch {
        // Ignore cleanup failure.
      }
    }
  }
}

export function sweepStaleTranscripts(dir: string, ageMs: number): void {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - ageMs;
  const entries = fs.readdirSync(dir);
  for (const entry of entries) {
    if (!entry.startsWith("x64dbg-mcp-elevated-") || !entry.endsWith(".log")) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.rmSync(full, { force: true });
      }
    } catch {
      // Ignore individual cleanup failures.
    }
  }
}

export interface PowerShellElevateOptions {
  exePath: string;
  args: string[];
}

export async function spawnElevatedPowerShell(opts: PowerShellElevateOptions): Promise<ElevatedSpawnResult> {
  const argList = opts.args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
  const psCommand = `$p = Start-Process -FilePath '${opts.exePath.replace(/'/g, "''")}' -ArgumentList @(${argList}) -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode`;

  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCommand], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
    child.on("error", () => resolve({ exitCode: 1 }));
  });
}

export function newTranscriptPath(): string {
  const uuid = `${Date.now()}-${Math.random().toString(16).slice(2)}-${process.pid}`;
  return path.join(transcriptDir(), `x64dbg-mcp-elevated-${uuid}.log`);
}

export function transcriptPattern(): string {
  return transcriptGlobPattern();
}
