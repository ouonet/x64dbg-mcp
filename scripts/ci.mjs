#!/usr/bin/env node
/**
 * Local CI runner — mirrors .github/workflows/ci.yml
 *
 * Usage:
 *   npm run ci              # full pipeline
 *   npm run ci -- --no-loader   # skip C loader build (no CMake needed)
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const skipLoader = args.includes("--no-loader");

const isTTY = process.stdout.isTTY;
const c = {
  ok:   isTTY ? "\x1b[32m" : "",
  fail: isTTY ? "\x1b[31m" : "",
  skip: isTTY ? "\x1b[2m"  : "",
  head: isTTY ? "\x1b[1;36m" : "",
  rst:  isTTY ? "\x1b[0m"  : "",
};

const results = [];

function step(name, fn) {
  process.stdout.write(`\n${c.head}── ${name}${c.rst}\n`);
  const t0 = Date.now();
  try {
    fn();
    const ms = Date.now() - t0;
    console.log(`${c.ok}✔ ${name}${c.rst}  (${ms}ms)`);
    results.push({ name, ok: true, ms });
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`${c.fail}✖ ${name}${c.rst}  (${ms}ms)`);
    results.push({ name, ok: false, ms });
  }
}

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function hasCmake() {
  return spawnSync("cmake", ["--version"], { stdio: "ignore" }).status === 0;
}

// ── pipeline steps ────────────────────────────────────────────────────────────

step("TypeScript build", () => run("npm run build"));

step("ESLint", () => run('npx eslint "src/**/*.ts"'));

step("Unit tests (TS)", () => run("npm test"));

step("Python syntax check", () =>
  run("python -m py_compile plugin/x64dbg_mcp_bridge.py plugin/x64dbg_bridge_sdk.py")
);

step("Python bridge tests", () => run("python plugin/test_bridge.py"));

if (skipLoader) {
  console.log(`\n${c.skip}── C loader build  [skipped via --no-loader]${c.rst}`);
  results.push({ name: "C loader build", ok: null });
} else if (!hasCmake()) {
  console.log(`\n${c.skip}── C loader build  [skipped — cmake not found]${c.rst}`);
  results.push({ name: "C loader build", ok: null });
} else {
  step("C loader build (x64)", () => {
    run("cmake -B plugin/loader/build64 -A x64 -S plugin/loader");
    run("cmake --build plugin/loader/build64 --config Release");
  });

  step("C loader build (x32)", () => {
    run("cmake -B plugin/loader/build32 -A Win32 -S plugin/loader -DBUILD_32BIT=ON");
    run("cmake --build plugin/loader/build32 --config Release");
  });

  step("Copy to prebuilt/", () => {
    const prebuilt = path.join(ROOT, "plugin", "loader", "prebuilt");
    fs.mkdirSync(prebuilt, { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, "plugin/loader/build64/Release/x64dbg_mcp_loader.dp64"),
      path.join(prebuilt, "x64dbg_mcp_loader.dp64")
    );
    fs.copyFileSync(
      path.join(ROOT, "plugin/loader/build32/Release/x64dbg_mcp_loader.dp32"),
      path.join(prebuilt, "x64dbg_mcp_loader.dp32")
    );
  });
}

// ── summary ───────────────────────────────────────────────────────────────────

const totalMs = results.reduce((s, r) => s + (r.ms || 0), 0);
const failed  = results.filter(r => r.ok === false);
const skipped = results.filter(r => r.ok === null);

console.log(`\n${"─".repeat(48)}`);
for (const r of results) {
  const icon = r.ok === true  ? `${c.ok}✔${c.rst}` :
               r.ok === false ? `${c.fail}✖${c.rst}` :
                                `${c.skip}-${c.rst}`;
  const ms = r.ms != null ? `${c.skip}(${r.ms}ms)${c.rst}` : `${c.skip}(skipped)${c.rst}`;
  console.log(`  ${icon}  ${r.name.padEnd(32)} ${ms}`);
}
console.log(`${"─".repeat(48)}`);
console.log(`  ${results.length} steps · ${failed.length} failed · ${skipped.length} skipped · ${totalMs}ms total\n`);

process.exit(failed.length > 0 ? 1 : 0);
