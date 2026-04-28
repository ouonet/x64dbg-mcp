#!/usr/bin/env node

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT       = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOADER_DIR = path.join(ROOT, "plugin", "loader");
const PREBUILT   = path.join(LOADER_DIR, "prebuilt");

// ── 1. Ensure dist/server.js exists ──────────────────────────────────────────
if (!fs.existsSync(path.join(ROOT, "dist", "server.js"))) {
  console.error("prepack: dist/server.js not found — run `npm run build` first.");
  process.exit(1);
}

// ── 2. Build C loader if prebuilt binaries are missing ───────────────────────
const dp64 = path.join(PREBUILT, "x64dbg_mcp_loader.dp64");
const dp32 = path.join(PREBUILT, "x64dbg_mcp_loader.dp32");
const needBuild = !fs.existsSync(dp64) || !fs.existsSync(dp32);

if (needBuild) {
  if (process.platform !== "win32") {
    console.error("prepack: prebuilt loader binaries are missing and can only be built on Windows.");
    console.error("  Build on Windows and copy dp64/dp32 into plugin/loader/prebuilt/ before publishing.");
    process.exit(1);
  }

  // Check CMake
  try { execSync("cmake --version", { stdio: "ignore" }); }
  catch {
    console.error("prepack: CMake not found. Install CMake to build the loader, or pre-copy dp64/dp32 into plugin/loader/prebuilt/.");
    process.exit(1);
  }

  fs.mkdirSync(PREBUILT, { recursive: true });

  if (!fs.existsSync(dp64)) {
    console.log("prepack: building x64 loader...");
    execSync(
      `cmake -B "${path.join(LOADER_DIR, "build64")}" -A x64 -S "${LOADER_DIR}" -DCMAKE_BUILD_TYPE=Release`,
      { stdio: "inherit" }
    );
    execSync(
      `cmake --build "${path.join(LOADER_DIR, "build64")}" --config Release`,
      { stdio: "inherit" }
    );
    const built = path.join(LOADER_DIR, "build64", "Release", "x64dbg_mcp_loader.dp64");
    if (!fs.existsSync(built)) { console.error("prepack: x64 build failed — dp64 not produced."); process.exit(1); }
    fs.copyFileSync(built, dp64);
    console.log("prepack: dp64 built and copied to prebuilt/");
  }

  if (!fs.existsSync(dp32)) {
    console.log("prepack: building x32 loader...");
    execSync(
      `cmake -B "${path.join(LOADER_DIR, "build32")}" -A Win32 -S "${LOADER_DIR}" -DBUILD_32BIT=ON -DCMAKE_BUILD_TYPE=Release`,
      { stdio: "inherit" }
    );
    execSync(
      `cmake --build "${path.join(LOADER_DIR, "build32")}" --config Release`,
      { stdio: "inherit" }
    );
    const built = path.join(LOADER_DIR, "build32", "Release", "x64dbg_mcp_loader.dp32");
    if (!fs.existsSync(built)) { console.error("prepack: x32 build failed — dp32 not produced."); process.exit(1); }
    fs.copyFileSync(built, dp32);
    console.log("prepack: dp32 built and copied to prebuilt/");
  }
}

console.log("x64dbg-mcp prepack check passed.");
