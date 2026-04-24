#!/usr/bin/env node
/**
 * x64dbg-mcp doctor — pre-flight diagnostics
 *
 * Usage:  npm run doctor
 *         node scripts/doctor.mjs
 *
 * Checks every prerequisite and prints a clear pass/fail table.
 * Exit code 0 = all checks passed, 1 = one or more failures.
 */

import { execSync } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── colour helpers ──────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const c = {
  ok:   isTTY ? "\x1b[32m" : "",
  fail: isTTY ? "\x1b[31m" : "",
  warn: isTTY ? "\x1b[33m" : "",
  dim:  isTTY ? "\x1b[2m"  : "",
  bold: isTTY ? "\x1b[1m"  : "",
  rst:  isTTY ? "\x1b[0m"  : "",
};

const results = [];

function check(label, status, detail = "") {
  const icon = status === "ok" ? `${c.ok}[OK]${c.rst}` :
               status === "warn" ? `${c.warn}[WARN]${c.rst}` :
               `${c.fail}[FAIL]${c.rst}`;
  const line = `  ${icon}  ${label}${detail ? `  ${c.dim}${detail}${c.rst}` : ""}`;
  results.push({ status, label, line });
  console.log(line);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function which(cmd) {
  try {
    const out = execSync(`where ${cmd} 2>nul`, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
    return out.trim().split("\n")[0].trim();
  } catch {
    return null;
  }
}

function resolveX64dbgPath() {
  const env = process.env.X64DBG_PATH;
  if (env && fs.existsSync(env)) return env;
  const localPath = path.join(ROOT, "x64dbg");
  if (fs.existsSync(localPath)) return localPath;
  for (const p of ["C:\\x64dbg", "C:\\Program Files\\x64dbg", "C:\\Tools\\x64dbg"]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function probeTCP(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once("error",   () => { clearTimeout(t); resolve(false); });
  });
}

// ── checks ───────────────────────────────────────────────────────────────────

console.log(`\n${c.bold}x64dbg-mcp doctor${c.rst}\n`);

// 1. Node.js version
const nodeVer = process.versions.node;
const [nodeMajor] = nodeVer.split(".").map(Number);
if (nodeMajor >= 20) check("Node.js >= 20", "ok", `v${nodeVer}`);
else check("Node.js >= 20", "fail", `found v${nodeVer} — upgrade required`);

// 2. Python 3.10+
let pythonOk = false;
for (const cmd of ["python", "python3", "py"]) {
  try {
    const ver = execSync(`${cmd} --version 2>&1`, { encoding: "utf8" }).trim();
    const m = ver.match(/Python (\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) {
      check("Python 3.10+", "ok", `${ver} (${cmd})`);
      pythonOk = true;
      break;
    }
  } catch { /* try next */ }
}
if (!pythonOk) check("Python 3.10+", "fail", "not found — install from python.org");

// 3. x64dbg path
const x64dbgPath = resolveX64dbgPath();
if (x64dbgPath) {
  check("x64dbg path", "ok", x64dbgPath);
} else {
  check("x64dbg path", "fail",
    "not found — set X64DBG_PATH env or install to C:\\x64dbg");
}

// 4. x64dbg executables
if (x64dbgPath) {
  const x64exe = path.join(x64dbgPath, "release", "x64", "x64dbg.exe");
  const x32exe = path.join(x64dbgPath, "release", "x32", "x32dbg.exe");
  if (fs.existsSync(x64exe)) check("x64dbg.exe", "ok", x64exe);
  else check("x64dbg.exe", "warn", `not found at ${x64exe}`);
  if (fs.existsSync(x32exe)) check("x32dbg.exe", "ok", x32exe);
  else check("x32dbg.exe", "warn", `not found at ${x32exe}`);
}

// 5. Plugin files deployed
if (x64dbgPath) {
  const pluginsDir = path.join(x64dbgPath, "release", "x64", "plugins");
  const dp64 = path.join(pluginsDir, "x64dbg_mcp_loader.dp64");
  const bridgePy = path.join(pluginsDir, "x64dbg_mcp_bridge.py");
  const sdkPy = path.join(pluginsDir, "x64dbg_bridge_sdk.py");

  if (fs.existsSync(dp64)) check("Loader plugin (.dp64)", "ok", dp64);
  else check("Loader plugin (.dp64)", "fail",
    `not found — run: npm run install-plugin`);

  if (fs.existsSync(bridgePy) && fs.existsSync(sdkPy)) {
    check("Python bridge files", "ok", pluginsDir);
  } else {
    check("Python bridge files", "fail",
      `missing in ${pluginsDir} — run: npm run install-plugin`);
  }
}

// 6. .env configuration
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  check(".env file", "ok", envFile);
} else {
  check(".env file", "warn",
    "not found — run: npm run setup  (or copy .env.example → .env)");
}

// 7. PYTHON_HOME_X64 / PYTHON_HOME_X86
const pyX64 = process.env.PYTHON_HOME_X64;
const pyX86 = process.env.PYTHON_HOME_X86;
if (pyX64) {
  const dll = fs.existsSync(path.join(pyX64, "python3.dll")) ||
              fs.readdirSync(pyX64).some(f => /^python3\d+\.dll$/i.test(f));
  if (dll) check("PYTHON_HOME_X64", "ok", pyX64);
  else check("PYTHON_HOME_X64", "warn", `set but no python3*.dll found in ${pyX64}`);
} else {
  check("PYTHON_HOME_X64", "warn", "not set — loader will fall back to PATH (or copy DLL to plugins)");
}
if (pyX86) {
  const dll = fs.existsSync(path.join(pyX86, "python3.dll")) ||
              fs.readdirSync(pyX86).some(f => /^python3\d+\.dll$/i.test(f));
  if (dll) check("PYTHON_HOME_X86", "ok", pyX86);
  else check("PYTHON_HOME_X86", "warn", `set but no python3*.dll found in ${pyX86}`);
} else {
  check("PYTHON_HOME_X86", "warn", "not set — 32-bit loader will fall back to PATH");
}

// 8. CMake (for building C loader)
const cmake = which("cmake");
if (cmake) check("CMake (for building loader)", "ok", cmake);
else check("CMake (for building loader)", "warn",
  "not found — only needed to build the C loader from source");

// 8. Bridge TCP reachability
const bridgeHost = process.env.BRIDGE_HOST || "127.0.0.1";
const bridgePort = parseInt(process.env.BRIDGE_PORT || "27042", 10);
const bridgeUp = await probeTCP(bridgeHost, bridgePort);
if (bridgeUp) {
  check(`Bridge TCP ${bridgeHost}:${bridgePort}`, "ok", "reachable (x64dbg is running)");
} else {
  check(`Bridge TCP ${bridgeHost}:${bridgePort}`, "warn",
    "not reachable (expected if x64dbg is not running)");
}

// ── summary ─────────────────────────────────────────────────────────────────

const failures = results.filter((r) => r.status === "fail");
const warnings = results.filter((r) => r.status === "warn");

console.log();
if (failures.length === 0 && warnings.length === 0) {
  console.log(`${c.ok}${c.bold}All checks passed.${c.rst}`);
} else {
  if (failures.length > 0) {
    console.log(`${c.fail}${failures.length} check(s) failed:${c.rst}`);
    failures.forEach((r) => console.log(`  • ${r.label}`));
  }
  if (warnings.length > 0) {
    console.log(`${c.warn}${warnings.length} warning(s):${c.rst}`);
    warnings.forEach((r) => console.log(`  • ${r.label}`));
  }
  if (failures.length > 0) {
    console.log(`\nRun ${c.bold}npm run setup${c.rst} to fix missing configuration.`);
    console.log(`Run ${c.bold}npm run install-plugin${c.rst} to deploy the bridge plugin.\n`);
  }
}
console.log();

process.exit(failures.length > 0 ? 1 : 0);
