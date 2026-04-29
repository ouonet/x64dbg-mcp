/**
 * Server configuration management
 */

import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { ServerConfig } from "./types.js";

const BRIDGE_AUTH_TOKEN_FILE = "x64dbg_mcp_bridge.token";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the .env file to load, in priority order:
 *  1. X64DBG_MCP_CONFIG env var  (explicit override)
 *  2. Global install → ~/.config/x64dbg-mcp/.env
 *  3. process.cwd()/.env         (local project)
 *  4. <pkg-root>/.env            (source repo dev / fallback)
 */
function resolveEnvFile(): string {
  if (process.env.X64DBG_MCP_CONFIG) return process.env.X64DBG_MCP_CONFIG;

  // Global install writes config to ~/.config/x64dbg-mcp/.env
  const globalEnv = path.join(os.homedir(), ".config", "x64dbg-mcp", ".env");
  if (fs.existsSync(globalEnv)) return globalEnv;

  const cwdEnv = path.join(process.cwd(), ".env");
  if (fs.existsSync(cwdEnv)) return cwdEnv;

  const pkgEnv = path.resolve(__dirname, "..", ".env");
  if (fs.existsSync(pkgEnv)) return pkgEnv;

  return cwdEnv;
}

dotenv.config({ path: resolveEnvFile() });

function normalizeX64dbgPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  const looksLikeReleaseDir = path.basename(resolved).toLowerCase() === "release";
  const hasDebuggerLayout =
    fs.existsSync(path.join(resolved, "x64", "x64dbg.exe")) ||
    fs.existsSync(path.join(resolved, "x32", "x32dbg.exe"));

  return looksLikeReleaseDir && hasDebuggerLayout ? path.dirname(resolved) : resolved;
}

function resolveX64dbgPath(): string {
  const envPath = process.env.X64DBG_PATH;
  if (envPath && fs.existsSync(envPath)) return normalizeX64dbgPath(envPath);

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
    if (fs.existsSync(p)) return normalizeX64dbgPath(p);
  }

  return envPath ? normalizeX64dbgPath(envPath) : "C:\\x64dbg";
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function normalizeBridgeToken(token: string): string {
  return token.replace(/^\uFEFF/, "").trim();
}

function resolveBridgeAuthToken(x64dbgPath: string): string {
  const envToken = normalizeBridgeToken(process.env.BRIDGE_AUTH_TOKEN || "");
  if (envToken) return envToken;

  const tokenCandidates = [
    path.join(x64dbgPath, "release", "x64", "plugins", BRIDGE_AUTH_TOKEN_FILE),
    path.join(x64dbgPath, "release", "x32", "plugins", BRIDGE_AUTH_TOKEN_FILE),
  ];

  for (const tokenPath of tokenCandidates) {
    if (!fs.existsSync(tokenPath)) continue;

    const token = normalizeBridgeToken(fs.readFileSync(tokenPath, "utf8"));
    if (token) return token;
  }

  return "";
}

export function loadConfig(): ServerConfig {
  const x64dbgPath = resolveX64dbgPath();
  const bridgeAuthToken = resolveBridgeAuthToken(x64dbgPath);

  // bridgeAuthToken may be empty at load time — the bridge will reject
  // unauthenticated connections with a clear error when a tool is first used.
  // This allows `x64dbg-mcp setup` / `x64dbg-mcp doctor` to run without a
  // fully configured .env.

  return {
    x64dbgPath,
    bridgeHost: process.env.BRIDGE_HOST || "127.0.0.1",
    bridgePort: parseEnvInt(process.env.BRIDGE_PORT, 27042),
    bridgeAuthToken,
    logLevel: (process.env.LOG_LEVEL as ServerConfig["logLevel"]) || "info",
    sessionTimeoutMs: parseEnvInt(process.env.SESSION_TIMEOUT_MS, 3_600_000),
    maxDisasmInstructions: parseEnvInt(process.env.MAX_DISASM_INSTRUCTIONS, 500),
    maxTraceInstructions: parseEnvInt(process.env.MAX_TRACE_INSTRUCTIONS, 10_000),
    maxSearchResults: parseEnvInt(process.env.MAX_SEARCH_RESULTS, 1000),
    maxStringLength: parseEnvInt(process.env.MAX_STRING_LENGTH, 256),
  };
}

export const config = loadConfig();
