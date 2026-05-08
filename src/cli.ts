export type CliTransport = "stdio" | "streamable-http";

export interface CliRuntimeOverrides {
  transport?: CliTransport;
  host?: string;
  port?: number;
  showHelp: boolean;
}

function normalizeTransport(value: string): CliTransport {
  const normalized = value.trim().toLowerCase();
  if (normalized === "stdio") return "stdio";
  if (normalized === "streamable-http" || normalized === "http") return "streamable-http";

  throw new Error(
    `Unsupported transport '${value}'. Supported values: stdio, streamable-http.`
  );
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port '${value}'. Expected an integer between 1 and 65535.`);
  }
  return port;
}

function readOptionValue(argv: string[], index: number, flag: string): { value: string; consumed: number } {
  const arg = argv[index];
  if (!arg) {
    throw new Error(`Missing value for ${flag}.`);
  }

  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length).trim();
    if (!value) throw new Error(`Missing value for ${flag}.`);
    return { value, consumed: 1 };
  }

  const next = argv[index + 1]?.trim();
  if (!next || next.startsWith("--")) {
    throw new Error(`Missing value for ${flag}.`);
  }

  return { value: next, consumed: 2 };
}

export function parseCliRuntimeOverrides(argv: string[]): CliRuntimeOverrides {
  const overrides: CliRuntimeOverrides = { showHelp: false };

  for (let index = 0; index < argv.length;) {
    const arg = argv[index];
    if (!arg) {
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      overrides.showHelp = true;
      index += 1;
      continue;
    }

    if (arg === "--transport" || arg.startsWith("--transport=")) {
      const { value, consumed } = readOptionValue(argv, index, "--transport");
      overrides.transport = normalizeTransport(value);
      index += consumed;
      continue;
    }

    if (arg === "--host" || arg.startsWith("--host=")) {
      const { value, consumed } = readOptionValue(argv, index, "--host");
      overrides.host = value;
      index += consumed;
      continue;
    }

    if (arg === "--port" || arg.startsWith("--port=")) {
      const { value, consumed } = readOptionValue(argv, index, "--port");
      overrides.port = parsePort(value);
      index += consumed;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return overrides;
}

export function renderCliUsage(): string {
  return [
    "Usage:",
    "  x64dbg-mcp [--transport stdio|streamable-http] [--host HOST] [--port PORT]",
    "",
    "Examples:",
    "  x64dbg-mcp",
    "  x64dbg-mcp --transport streamable-http --host localhost --port 3602",
    "",
    "Notes:",
    "  - The Streamable HTTP endpoint path is fixed at /mcp.",
    "  - CLI arguments override MCP_TRANSPORT / MCP_HTTP_HOST / MCP_HTTP_PORT from the environment.",
  ].join("\n");
}

export interface ServiceModeArgs {
  serviceArgv: string[];
}

export function detectServiceMode(argv: string[]): ServiceModeArgs | null {
  if (argv.length === 0) return null;
  if (argv[0] === "service") {
    return { serviceArgv: argv.slice(1) };
  }
  return null;
}