#!/usr/bin/env node
/**
 * postinstall — runs automatically after `npm install x64dbg-mcp`
 *
 * Goals (non-interactive, safe to re-run):
 *   1. Find x64dbg installation
 *   2. Deploy prebuilt .dp64/.dp32 loader + Python bridge files to plugins/
 *   3. Auto-detect Python 64/32-bit paths
 *   4. Create/update .env with discovered settings
 *   5. Print a clear summary
 *
 * Fails gracefully — missing x64dbg or Python is a warning, not a fatal error.
 * The user can always run `npm run setup` + `npm run doctor` to finish config.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  BRIDGE_AUTH_TOKEN_FILE,
  ensureBridgeAuthToken,
  writeBridgeTokenFile,
} from "./bridge-auth.mjs";

// When installed as a dependency: __dirname = node_modules/x64dbg-mcp/scripts
// When installed globally:        __dirname = <global>/node_modules/x64dbg-mcp/scripts
const PKG_ROOT  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// .env lives in the consuming project root (global: PKG_ROOT itself)
const PROJECT_ROOT = process.env.INIT_CWD || PKG_ROOT;
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

const isTTY = process.stdout.isTTY;
const c = {
  ok:   isTTY ? "\x1b[32m" : "",
  warn: isTTY ? "\x1b[33m" : "",
  info: isTTY ? "\x1b[36m" : "",
  bold: isTTY ? "\x1b[1m"  : "",
  dim:  isTTY ? "\x1b[2m"  : "",
  rst:  isTTY ? "\x1b[0m"  : "",
};

const log  = (m) => console.log(m);
const ok   = (m) => log(`  ${c.ok}✔${c.rst}  ${m}`);
const warn = (m) => log(`  ${c.warn}⚠${c.rst}  ${m}`);
const info = (m) => log(`  ${c.info}→${c.rst}  ${m}`);

// ── helpers ──────────────────────────────────────────────────────────────────

function findX64dbg() {
  const candidates = [
    path.join(PKG_ROOT, "x64dbg"),
    process.env.X64DBG_PATH,
    "C:\\x64dbg",
    "C:\\Program Files\\x64dbg",
    "C:\\Tools\\x64dbg",
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, "x64dbg"),
  ].filter(Boolean);
  const found = candidates.find((p) => p && fs.existsSync(p)) || null;
  if (!found) return null;

  const resolved = path.resolve(found);
  const looksLikeReleaseDir = path.basename(resolved).toLowerCase() === "release";
  const hasDebuggerLayout =
    fs.existsSync(path.join(resolved, "x64", "x64dbg.exe")) ||
    fs.existsSync(path.join(resolved, "x32", "x32dbg.exe"));

  return looksLikeReleaseDir && hasDebuggerLayout ? path.dirname(resolved) : resolved;
}

function findPythonDir(arch) {
  // arch: "x64" | "x86"
  // Try: where python/python3/py → get install dir → verify DLL present
  const cmds = arch === "x86"
    ? ["py -3-32", "python3-32"]
    : ["python", "python3", "py -3"];

  for (const cmd of cmds) {
    try {
      const raw = execSync(`${cmd} -c "import sys; print(sys.executable)"`,
        { encoding: "utf8", stdio: ["pipe","pipe","pipe"], timeout: 5000 });
      const exePath = raw.trim();
      if (!exePath) continue;
      const dir = path.dirname(exePath);
      // Verify a python3*.dll exists there
      const hasDll = fs.existsSync(path.join(dir, "python3.dll")) ||
        fs.readdirSync(dir).some(f => /^python3\d+\.dll$/i.test(f));
      if (hasDll) return dir;
    } catch { /* try next */ }
  }
  return null;
}

function parseEnv(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    map.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return map;
}

function writeEnv(map) {
  // Preserve comment header from .env.example if .env doesn't exist yet
  const lines = [];
  if (!fs.existsSync(ENV_FILE)) {
    const examplePath = path.join(PKG_ROOT, ".env.example");
    if (fs.existsSync(examplePath)) {
      // Copy comment lines from example as header
      for (const line of fs.readFileSync(examplePath, "utf8").split("\n")) {
        if (line.trim().startsWith("#")) lines.push(line);
        else break;
      }
      lines.push("");
    }
  }
  for (const [k, v] of map) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

// ── main ─────────────────────────────────────────────────────────────────────

log(`\n${c.bold}x64dbg-mcp postinstall${c.rst}\n`);

let envChanged = false;
const env = fs.existsSync(ENV_FILE)
  ? parseEnv(fs.readFileSync(ENV_FILE, "utf8"))
  : new Map();
const { token: bridgeAuthToken, created: createdBridgeAuthToken } = ensureBridgeAuthToken(env);
if (createdBridgeAuthToken) envChanged = true;

// 1. Locate x64dbg — auto-download if not present ─────────────────────────────
let x64dbgPath = findX64dbg();
if (!x64dbgPath) {
  info("x64dbg not found locally — downloading latest snapshot…");
  try {
    execSync("node scripts/setup-x64dbg.mjs", { stdio: "inherit", cwd: PKG_ROOT });
    x64dbgPath = findX64dbg();
  } catch {
    warn("x64dbg download failed — run: npm run setup-x64dbg");
  }
}
if (x64dbgPath) {
  ok(`x64dbg: ${x64dbgPath}`);
  if (env.get("X64DBG_PATH") !== x64dbgPath) { env.set("X64DBG_PATH", x64dbgPath); envChanged = true; }
} else {
  warn("x64dbg not found — set X64DBG_PATH in .env");
}

// 2. Deploy plugin files ───────────────────────────────────────────────────────
const prebuiltDir = path.join(PKG_ROOT, "plugin", "loader", "prebuilt");
const pyFiles = [
  path.join(PKG_ROOT, "plugin", "x64dbg_mcp_bridge.py"),
  path.join(PKG_ROOT, "plugin", "x64dbg_bridge_sdk.py"),
];
const loaders = {
  x64: path.join(prebuiltDir, "x64dbg_mcp_loader.dp64"),
  x32: path.join(prebuiltDir, "x64dbg_mcp_loader.dp32"),
};

if (x64dbgPath) {
  for (const arch of ["x64", "x32"]) {
    const pluginsDir = path.join(x64dbgPath, "release", arch, "plugins");
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }

    // Deploy loader binary
    const loaderSrc = loaders[arch];
    const ext = arch === "x64" ? ".dp64" : ".dp32";
    if (fs.existsSync(loaderSrc)) {
      const dst = path.join(pluginsDir, `x64dbg_mcp_loader${ext}`);
      fs.copyFileSync(loaderSrc, dst);
      ok(`Deployed ${path.basename(dst)} → ${pluginsDir}`);
    } else {
      warn(`Prebuilt loader not found for ${arch}: ${loaderSrc}`);
      info(`Run: npm run install-plugin  (requires CMake + MSVC)`);
    }

    // Deploy Python bridge files
    let pyOk = true;
    for (const src of pyFiles) {
      if (!fs.existsSync(src)) { pyOk = false; continue; }
      const dst = path.join(pluginsDir, path.basename(src));
      const srcBuf = fs.readFileSync(src);
      const dstBuf = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      if (!dstBuf || !srcBuf.equals(dstBuf)) {
        fs.copyFileSync(src, dst);
      }
    }
    if (pyOk) ok(`Python bridge files deployed → ${pluginsDir}`);

    const tokenPath = path.join(pluginsDir, BRIDGE_AUTH_TOKEN_FILE);
    if (writeBridgeTokenFile(tokenPath, bridgeAuthToken)) {
      ok(`Bridge auth token deployed → ${tokenPath}`);
    }
  }
}

// 3. Auto-detect Python ────────────────────────────────────────────────────────
if (!env.has("PYTHON_HOME_X64") || !env.get("PYTHON_HOME_X64")) {
  const dir = findPythonDir("x64");
  if (dir) {
    env.set("PYTHON_HOME_X64", dir);
    envChanged = true;
    ok(`Python x64 detected: ${dir}`);
  } else {
    warn("Python 64-bit not found — set PYTHON_HOME_X64 in .env");
  }
}

if (!env.has("PYTHON_HOME_X86") || !env.get("PYTHON_HOME_X86")) {
  const dir = findPythonDir("x86");
  if (dir) {
    env.set("PYTHON_HOME_X86", dir);
    envChanged = true;
    ok(`Python x86 detected: ${dir}`);
  } else {
    warn("Python 32-bit not found — set PYTHON_HOME_X86 in .env (optional)");
  }
}

// 4. Ensure baseline .env values ──────────────────────────────────────────────
const defaults = {
  BRIDGE_HOST: "127.0.0.1",
  BRIDGE_PORT: "27042",
  LOG_LEVEL: "info",
  SESSION_TIMEOUT_MS: "3600000",
};
for (const [k, v] of Object.entries(defaults)) {
  if (!env.has(k)) { env.set(k, v); envChanged = true; }
}

if (env.get("MAX_SESSIONS") !== "1") {
  env.set("MAX_SESSIONS", "1");
  envChanged = true;
}

if (envChanged) {
  writeEnv(env);
  ok(`.env written: ${ENV_FILE}`);
}

if (createdBridgeAuthToken) {
  ok("Generated BRIDGE_AUTH_TOKEN for local bridge authentication");
}

// 5. Summary ──────────────────────────────────────────────────────────────────
log(`
${c.bold}Next steps:${c.rst}
  1. Start x64dbg — the loader plugin auto-starts the Python bridge.
  2. Configure your AI assistant (Claude Desktop, Cursor, Windsurf …):
     {
       "mcpServers": {
         "x64dbg": { "command": "node", "args": ["${
           path.join(PKG_ROOT, "dist", "server.js").replace(/\\/g, "\\\\")
         }"] }
       }
     }
  3. Run ${c.bold}npm run doctor${c.rst} to verify the full setup.
`);
