import fs from "node:fs";
import path from "node:path";
import { serviceEnvFile, serviceRootDir } from "./paths.js";

const MANAGED_KEYS = ["MCP_TRANSPORT", "MCP_HTTP_HOST", "MCP_HTTP_PORT"] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface MergeOptions {
  host: string;
  port: number;
}

function buildManagedValues(opts: MergeOptions): Record<ManagedKey, string> {
  return {
    MCP_TRANSPORT: "streamable-http",
    MCP_HTTP_HOST: opts.host,
    MCP_HTTP_PORT: String(opts.port),
  };
}

export function mergeServiceEnv(opts: MergeOptions): void {
  const file = serviceEnvFile();
  fs.mkdirSync(serviceRootDir(), { recursive: true });

  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const managed = buildManagedValues(opts);
  const lines = existing.split(/\r?\n/);

  const seen = new Set<string>();
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (MANAGED_KEYS.includes(key as ManagedKey)) {
      seen.add(key);
      return `${key}=${managed[key as ManagedKey]}`;
    }
    return line;
  });

  // Trim a trailing empty line (from split) so we don't accumulate blanks.
  if (updated.length > 0 && updated[updated.length - 1] === "") {
    updated.pop();
  }

  for (const key of MANAGED_KEYS) {
    if (!seen.has(key)) {
      updated.push(`${key}=${managed[key]}`);
    }
  }

  // Always end with a single newline.
  fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");
}
