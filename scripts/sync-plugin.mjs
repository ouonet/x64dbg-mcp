#!/usr/bin/env node
/**
 * sync-plugin — copy Python bridge files from plugin/ into the bundled
 * x64dbg plugins directories so the running debugger always uses the
 * latest source without a manual copy step.
 *
 * Targets:
 *   x64dbg/release/x64/plugins/
 *   x64dbg/release/x32/plugins/   (if it exists)
 *
 * Usage:
 *   npm run sync-plugin          standalone sync
 *   npm run dev                  runs sync automatically (via predev hook)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const SOURCES = [
  "x64dbg_mcp_bridge.py",
  "x64dbg_bridge_sdk.py",
];

const TARGETS = [
  path.join(ROOT, "x64dbg", "release", "x64", "plugins"),
  path.join(ROOT, "x64dbg", "release", "x32", "plugins"),
];

const isTTY = process.stdout.isTTY;
const c = {
  ok:  isTTY ? "\x1b[32m" : "",
  dim: isTTY ? "\x1b[2m"  : "",
  rst: isTTY ? "\x1b[0m"  : "",
};

let synced = 0;
let skipped = 0;

for (const dest of TARGETS) {
  if (!fs.existsSync(dest)) {
    console.log(`${c.dim}  skip  ${dest} (not found)${c.rst}`);
    continue;
  }

  for (const file of SOURCES) {
    const src = path.join(ROOT, "plugin", file);
    const dst = path.join(dest, file);

    if (!fs.existsSync(src)) {
      console.warn(`  warn  source not found: ${src}`);
      continue;
    }

    // Only copy if content differs (avoid touching mtime unnecessarily,
    // which would cause x64dbg to re-import the module mid-session).
    const srcBuf = fs.readFileSync(src);
    const dstBuf = fs.existsSync(dst) ? fs.readFileSync(dst) : null;

    if (dstBuf && srcBuf.equals(dstBuf)) {
      console.log(`${c.dim}  same  ${path.relative(ROOT, dst)}${c.rst}`);
      skipped++;
    } else {
      fs.copyFileSync(src, dst);
      console.log(`${c.ok}  sync  ${path.relative(ROOT, dst)}${c.rst}`);
      synced++;
    }
  }
}

if (synced > 0 || skipped > 0) {
  console.log(`${c.dim}  [sync-plugin] ${synced} updated, ${skipped} unchanged${c.rst}`);
}
