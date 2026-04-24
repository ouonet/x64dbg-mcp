/**
 * Server configuration management
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import type { ServerConfig } from "./types.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveX64dbgPath(): string {
  const envPath = process.env.X64DBG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  // Project-local x64dbg directory (sibling to src/ and dist/)
  const projectLocal = path.resolve(__dirname, "..", "x64dbg");

  const defaultPaths = [
    projectLocal,
    "C:\\x64dbg",
    "C:\\Program Files\\x64dbg",
    "C:\\Tools\\x64dbg",
    path.join(process.env.USERPROFILE || "", "x64dbg"),
  ];

  for (const p of defaultPaths) {
    if (fs.existsSync(p)) return p;
  }

  return envPath || "C:\\x64dbg";
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): ServerConfig {
  return {
    x64dbgPath: resolveX64dbgPath(),
    bridgeHost: process.env.BRIDGE_HOST || "127.0.0.1",
    bridgePort: parseEnvInt(process.env.BRIDGE_PORT, 27042),
    logLevel: (process.env.LOG_LEVEL as ServerConfig["logLevel"]) || "info",
    maxSessions: parseEnvInt(process.env.MAX_SESSIONS, 5),
    sessionTimeoutMs: parseEnvInt(process.env.SESSION_TIMEOUT_MS, 3_600_000),
    maxDisasmInstructions: parseEnvInt(process.env.MAX_DISASM_INSTRUCTIONS, 500),
    maxTraceInstructions: parseEnvInt(process.env.MAX_TRACE_INSTRUCTIONS, 10_000),
    maxSearchResults: parseEnvInt(process.env.MAX_SEARCH_RESULTS, 1000),
    maxStringLength: parseEnvInt(process.env.MAX_STRING_LENGTH, 256),
  };
}

export const config = loadConfig();
