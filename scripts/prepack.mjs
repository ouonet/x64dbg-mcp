#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const requiredArtifacts = [
  {
    filePath: path.join(ROOT, "dist", "server.js"),
    fix: "Run npm run build before packing or publishing.",
  },
  {
    filePath: path.join(ROOT, "plugin", "loader", "prebuilt", "x64dbg_mcp_loader.dp64"),
    fix: "Build or copy the x64 loader into plugin/loader/prebuilt/ before publishing.",
  },
  {
    filePath: path.join(ROOT, "plugin", "loader", "prebuilt", "x64dbg_mcp_loader.dp32"),
    fix: "Build or copy the x32 loader into plugin/loader/prebuilt/ before publishing.",
  },
];

const missing = requiredArtifacts.filter(({ filePath }) => !fs.existsSync(filePath));

if (missing.length > 0) {
  console.error("x64dbg-mcp prepack check failed. Missing required artifacts:\n");
  for (const { filePath, fix } of missing) {
    console.error(`- ${path.relative(ROOT, filePath)}\n  ${fix}`);
  }
  process.exit(1);
}

console.log("x64dbg-mcp prepack check passed.");