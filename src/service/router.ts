import type { StartType } from "./types.js";
import {
  SERVICE_DEFAULT_DISPLAY_NAME,
  SERVICE_DEFAULT_HOST,
  SERVICE_DEFAULT_PORT,
  SERVICE_DEFAULT_START_TYPE,
} from "./types.js";

export type ServiceCommand = "install" | "uninstall" | "start" | "stop" | "restart" | "status";

export interface ServiceCliOptions {
  port: number;
  host: string;
  displayName: string;
  startType: StartType;
  logDir?: string;
  elevate: boolean;
  transcript?: string;
}

export interface ParsedServiceCli {
  command: ServiceCommand;
  options: ServiceCliOptions;
}

const KNOWN_COMMANDS: ServiceCommand[] = ["install", "uninstall", "start", "stop", "restart", "status"];
const VALID_START_TYPES: StartType[] = ["auto", "delayed-auto", "manual"];

function defaultOptions(): ServiceCliOptions {
  return {
    port: SERVICE_DEFAULT_PORT,
    host: SERVICE_DEFAULT_HOST,
    displayName: SERVICE_DEFAULT_DISPLAY_NAME,
    startType: SERVICE_DEFAULT_START_TYPE,
    elevate: false,
  };
}

function readValue(argv: string[], i: number, flag: string): { value: string; next: number } {
  const arg = argv[i];
  if (arg.includes("=")) {
    const idx = arg.indexOf("=");
    const value = arg.slice(idx + 1);
    if (!value) throw new Error(`Missing value for ${flag}`);
    return { value, next: i + 1 };
  }
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return { value: next, next: i + 2 };
}

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port '${raw}'. Expected integer between 1 and 65535.`);
  }
  return port;
}

function parseStartType(raw: string): StartType {
  if (!VALID_START_TYPES.includes(raw as StartType)) {
    throw new Error(`Invalid --start '${raw}'. Expected one of: ${VALID_START_TYPES.join(", ")}.`);
  }
  return raw as StartType;
}

function flagName(arg: string): string {
  return arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
}

export function parseServiceArgs(argv: string[]): ParsedServiceCli {
  if (argv.length === 0) {
    throw new Error("Missing service subcommand. Use install / uninstall / start / stop / restart / status.");
  }
  const command = argv[0] as ServiceCommand;
  if (!KNOWN_COMMANDS.includes(command)) {
    throw new Error(`Unknown service subcommand: ${command}`);
  }

  const options = defaultOptions();

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    const flag = flagName(arg);

    switch (flag) {
      case "--port": {
        const { value, next } = readValue(argv, i, "--port");
        options.port = parsePort(value);
        i = next;
        break;
      }
      case "--host": {
        const { value, next } = readValue(argv, i, "--host");
        options.host = value;
        i = next;
        break;
      }
      case "--display-name": {
        const { value, next } = readValue(argv, i, "--display-name");
        options.displayName = value;
        i = next;
        break;
      }
      case "--start": {
        const { value, next } = readValue(argv, i, "--start");
        options.startType = parseStartType(value);
        i = next;
        break;
      }
      case "--log-dir": {
        const { value, next } = readValue(argv, i, "--log-dir");
        options.logDir = value;
        i = next;
        break;
      }
      case "--elevate": {
        options.elevate = true;
        i += 1;
        break;
      }
      case "--transcript": {
        const { value, next } = readValue(argv, i, "--transcript");
        options.transcript = value;
        i = next;
        break;
      }
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command, options };
}

export async function runService(serviceArgv: string[]): Promise<number> {
  let parsed: ParsedServiceCli;
  try {
    parsed = parseServiceArgs(serviceArgv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ ${message}\n`);
    return 1;
  }

  switch (parsed.command) {
    case "install": {
      const { runInstall } = await import("./install.js");
      return runInstall(parsed.options);
    }
    case "uninstall": {
      const { runUninstall } = await import("./uninstall.js");
      return runUninstall(parsed.options);
    }
    case "start":
    case "stop":
    case "restart": {
      const { runLifecycle } = await import("./lifecycle.js");
      return runLifecycle(parsed.command, parsed.options);
    }
    case "status": {
      const { runStatus } = await import("./status.js");
      return runStatus();
    }
  }
}
