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
 *   - LOG_LEVEL
 *
 * Then prints what to do next (install plugin, verify with doctor).
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

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
  warn("Could not auto-detect x64dbg. Common locations: C:\\x64dbg, C:\\Program Files\\x64dbg");
  const input = await prompt(rl,
    `Enter x64dbg directory path [${x64dbgPath || "skip"}]: `);
  if (input.trim()) x64dbgPath = input.trim();
}

if (x64dbgPath && !fs.existsSync(x64dbgPath)) {
  warn(`Warning: path does not exist: ${x64dbgPath}`);
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

// Ensure sensible defaults are present
if (!env.has("BRIDGE_HOST")) env.set("BRIDGE_HOST", "127.0.0.1");
if (!env.has("MAX_SESSIONS")) env.set("MAX_SESSIONS", "5");
if (!env.has("SESSION_TIMEOUT_MS")) env.set("SESSION_TIMEOUT_MS", "3600000");

fs.writeFileSync(ENV_FILE, serializeEnv(env), "utf8");
ok(`\n.env written to ${ENV_FILE}`);

// ── Next steps ────────────────────────────────────────────────────────────────

log(`
${c.bold}Next steps:${c.rst}

  1. ${c.info}Build & deploy the bridge plugin${c.rst}
     npm run install-plugin

  2. ${c.info}Verify everything is in order${c.rst}
     npm run doctor

  3. ${c.info}Start x64dbg, then start the MCP server${c.rst}
     npm start

  4. ${c.info}Configure your AI assistant${c.rst} (e.g. Claude Desktop mcp.json):
     {
       "mcpServers": {
         "x64dbg": {
           "command": "node",
           "args": ["${path.join(ROOT, "dist", "server.js").replace(/\\/g, "\\\\")}"]
         }
       }
     }
`);
