#!/usr/bin/env node
/**
 * x64dbg-mcp setup — first-run configuration wizard
 *
 * Usage:  npm run setup
 *         node scripts/setup.mjs
 *
 * Creates / updates .env with:
 *   - X64DBG_PATH  (auto-detected or prompted)
 *   - BRIDGE_PORT
 *   - BRIDGE_AUTH_TOKEN
 *   - LOG_LEVEL
 *
 * Then prints what to do next (install plugin, verify with doctor).
 */

import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { ensureBridgeAuthToken } from "./bridge-auth.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

// Install context detection
const isGlobalInstall = process.env.npm_config_global === "true";
const isDevInstall    = !isGlobalInstall && (
  !process.env.INIT_CWD ||
  path.resolve(process.env.INIT_CWD) === path.resolve(ROOT)
);

/** Returns the right command depending on install context. */
function cmd(npmScript, subcommand) {
  return isDevInstall ? `npm run ${npmScript}` : `x64dbg-mcp ${subcommand}`;
}

/**
 * Resolve where .env should be read from / written to.
 *
 * Priority:
 *  1. X64DBG_MCP_CONFIG env var  (explicit override)
 *  2. Global install → ~/.config/x64dbg-mcp/.env
 *  3. cwd/.env exists            (user is already in a configured project)
 *  4. Local/dev → cwd/.env       (write here for local & source-repo installs)
 */
function resolveEnvFile() {
  if (process.env.X64DBG_MCP_CONFIG) return process.env.X64DBG_MCP_CONFIG;
  if (isGlobalInstall) {
    const dir = path.join(os.homedir(), ".config", "x64dbg-mcp");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, ".env");
  }
  // For both local-project and source-repo installs, write into cwd
  return path.join(process.env.INIT_CWD || process.cwd(), ".env");
}

const ENV_FILE = resolveEnvFile();

const isTTY = process.stdout.isTTY;
const c = {
  ok:   isTTY ? "\x1b[32m" : "",
  info: isTTY ? "\x1b[36m" : "",
  warn: isTTY ? "\x1b[33m" : "",
  bold: isTTY ? "\x1b[1m"  : "",
  dim:  isTTY ? "\x1b[2m"  : "",
  rst:  isTTY ? "\x1b[0m"  : "",
};

// ── helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(msg); }
function info(msg) { log(`${c.info}${msg}${c.rst}`); }
function ok(msg)   { log(`${c.ok}${msg}${c.rst}`); }
function warn(msg) { log(`${c.warn}${msg}${c.rst}`); }

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

function serializeEnv(map) {
  return [...map.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── x64dbg path candidates ───────────────────────────────────────────────────

function findX64dbgCandidates() {
  const found = [];
  const check = (p) => { if (fs.existsSync(p)) found.push(p); };
  check(path.join(ROOT, "x64dbg"));
  check("C:\\x64dbg");
  check("C:\\Program Files\\x64dbg");
  check("C:\\Tools\\x64dbg");
  const profile = process.env.USERPROFILE;
  if (profile) check(path.join(profile, "x64dbg"));
  return found;
}

function normalizeX64dbgPath(candidate) {
  const resolved = path.resolve(candidate);
  const looksLikeReleaseDir = path.basename(resolved).toLowerCase() === "release";
  const hasDebuggerLayout =
    fs.existsSync(path.join(resolved, "x64", "x64dbg.exe")) ||
    fs.existsSync(path.join(resolved, "x32", "x32dbg.exe"));

  return looksLikeReleaseDir && hasDebuggerLayout ? path.dirname(resolved) : resolved;
}

// ── main ─────────────────────────────────────────────────────────────────────

log(`\n${c.bold}x64dbg-mcp setup${c.rst}\n`);

// Load existing .env or start from .env.example
let existing = new Map();
if (fs.existsSync(ENV_FILE)) {
  info(`Found existing .env at ${ENV_FILE}`);
  existing = parseEnv(fs.readFileSync(ENV_FILE, "utf8"));
} else if (fs.existsSync(ENV_EXAMPLE)) {
  info(`No .env found — starting from .env.example`);
  existing = parseEnv(fs.readFileSync(ENV_EXAMPLE, "utf8"));
} else {
  info("Starting with defaults");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ── Q1: X64DBG_PATH ──────────────────────────────────────────────────────────

const candidates = findX64dbgCandidates();
let x64dbgPath = existing.get("X64DBG_PATH") || candidates[0] || "";

if (candidates.length > 0) {
  info(`Auto-detected x64dbg paths:`);
  candidates.forEach((p, i) => log(`  [${i + 1}] ${p}`));
  log(`  [0] Enter a custom path`);
  const pick = await prompt(rl,
    `\nSelect x64dbg path [default: ${x64dbgPath || candidates[0]}]: `);
  if (pick.trim() === "0") {
    x64dbgPath = (await prompt(rl, "Enter x64dbg directory path: ")).trim();
  } else if (pick.trim() !== "") {
    const idx = parseInt(pick, 10) - 1;
    x64dbgPath = candidates[idx] ?? x64dbgPath;
  } else {
    x64dbgPath = x64dbgPath || candidates[0];
  }
} else {
  // No x64dbg found anywhere. Try to auto-download the latest release.
  // Dev install: download to ROOT/x64dbg.
  // Global install: download to ~/.config/x64dbg-mcp/x64dbg.
  // Local dependency: download to INIT_CWD/x64dbg.
  const bundledPath = isDevInstall
    ? path.join(ROOT, "x64dbg")
    : isGlobalInstall
      ? path.join(os.homedir(), ".config", "x64dbg-mcp", "x64dbg")
      : path.join(process.env.INIT_CWD || process.cwd(), "x64dbg");
  if (!fs.existsSync(bundledPath)) {
    info("x64dbg not found locally. Attempting to download the latest release…");
    try {
      const setupX64 = path.join(ROOT, "scripts", "setup-x64dbg.mjs");
      const destFlag = isDevInstall ? "" : `--dest ${JSON.stringify(bundledPath)}`;
      execSync(`node ${JSON.stringify(setupX64)} ${destFlag}`.trim(),
        { stdio: "inherit", cwd: ROOT });
    } catch {
      warn(`Download failed. You can retry later with: ${cmd("setup", "setup")}\n  Or add --snapshot to fetch a nightly build instead.`);
    }
  }

  // Re-check after potential download
  if (fs.existsSync(bundledPath)) {
    x64dbgPath = bundledPath;
    ok(`Using bundled x64dbg: ${bundledPath}`);
    const customize = await prompt(rl,
      `Use a different x64dbg path? [y/N]: `);
    if (customize.trim().toLowerCase() === "y") {
      x64dbgPath = (await prompt(rl, "Enter x64dbg directory path: ")).trim() || bundledPath;
    }
  } else {
    warn("Could not auto-detect x64dbg. Common locations: C:\\x64dbg, C:\\Program Files\\x64dbg");
    const defaultInput = isDevInstall ? (x64dbgPath || "skip") : bundledPath;
    const input = await prompt(rl,
      `Enter x64dbg directory path [${defaultInput}]: `);
    if (input.trim()) x64dbgPath = input.trim();
    else if (!isDevInstall) x64dbgPath = bundledPath;
  }
}

if (x64dbgPath && !fs.existsSync(x64dbgPath)) {
  warn(`Warning: path does not exist: ${x64dbgPath}`);
} else if (x64dbgPath) {
  x64dbgPath = normalizeX64dbgPath(x64dbgPath);
}

// ── Q2: BRIDGE_PORT ──────────────────────────────────────────────────────────

const defaultPort = existing.get("BRIDGE_PORT") || "27042";
const portInput = await prompt(rl, `Bridge TCP port [${defaultPort}]: `);
const bridgePort = portInput.trim() || defaultPort;

// ── Q3: LOG_LEVEL ────────────────────────────────────────────────────────────

const defaultLevel = existing.get("LOG_LEVEL") || "info";
const levelInput = await prompt(rl, `Log level (error|warn|info|debug) [${defaultLevel}]: `);
const logLevel = ["error", "warn", "info", "debug"].includes(levelInput.trim())
  ? levelInput.trim()
  : defaultLevel;

rl.close();

// ── Write .env ───────────────────────────────────────────────────────────────

const env = new Map(existing);
if (x64dbgPath) env.set("X64DBG_PATH", x64dbgPath);
env.set("BRIDGE_PORT", bridgePort);
env.set("LOG_LEVEL", logLevel);
const { created: createdBridgeAuthToken } = ensureBridgeAuthToken(env);

// Ensure sensible defaults are present
if (!env.has("BRIDGE_HOST")) env.set("BRIDGE_HOST", "127.0.0.1");
env.set("MAX_SESSIONS", "1");
if (!env.has("SESSION_TIMEOUT_MS")) env.set("SESSION_TIMEOUT_MS", "3600000");

fs.writeFileSync(ENV_FILE, serializeEnv(env), "utf8");
ok(`\n.env written to ${ENV_FILE}`);
if (createdBridgeAuthToken) {
  info("Generated BRIDGE_AUTH_TOKEN for local bridge authentication.");
}

// ── Next steps ────────────────────────────────────────────────────────────────

log(`
${c.bold}Next steps:${c.rst}

  1. ${c.info}Build & deploy the bridge plugin${c.rst}
     ${cmd("install-plugin", "install-plugin")}

  2. ${c.info}Verify everything is in order${c.rst}
     ${cmd("doctor", "doctor")}

  3. ${c.info}Start x64dbg, then start the MCP server${c.rst}
     ${isDevInstall ? "npm run dev" : "x64dbg-mcp"}

  4. ${c.info}Configure your AI assistant${c.rst} (e.g. Claude Desktop mcp.json):
${isDevInstall
  ? `     {
       "mcpServers": {
         "x64dbg": { "command": "node", "args": ["${path.join(ROOT, "dist", "server.js").replace(/\\/g, "\\\\")}"] }
       }
     }`
  : `     {
       "mcpServers": {
         "x64dbg": { "command": "x64dbg-mcp" }
       }
     }`}
`);
