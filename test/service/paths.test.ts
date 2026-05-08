import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  serviceRootDir,
  serviceWrapperDir,
  serviceEnvFile,
  serviceLogsDir,
  serviceShimPath,
  installedJsonPath,
  transcriptPath,
  transcriptGlobPattern,
} from "../../src/service/paths.js";

describe("service paths", () => {
  test("uses %ProgramData% when env var is set", () => {
    const original = process.env.PROGRAMDATA;
    process.env.PROGRAMDATA = "C:\\TestProgramData";
    try {
      assert.equal(serviceRootDir(), "C:\\TestProgramData\\x64dbg-mcp");
      assert.equal(serviceWrapperDir(), "C:\\TestProgramData\\x64dbg-mcp\\service");
      assert.equal(serviceEnvFile(), "C:\\TestProgramData\\x64dbg-mcp\\.env");
      assert.equal(serviceLogsDir(), "C:\\TestProgramData\\x64dbg-mcp\\logs");
      assert.equal(serviceShimPath(), "C:\\TestProgramData\\x64dbg-mcp\\service\\x64dbg-mcp-shim.mjs");
      assert.equal(installedJsonPath(), "C:\\TestProgramData\\x64dbg-mcp\\service\\installed.json");
    } finally {
      process.env.PROGRAMDATA = original;
    }
  });

  test("falls back to C:\\ProgramData when env var missing", () => {
    const original = process.env.PROGRAMDATA;
    delete process.env.PROGRAMDATA;
    try {
      assert.equal(serviceRootDir(), "C:\\ProgramData\\x64dbg-mcp");
    } finally {
      if (original !== undefined) process.env.PROGRAMDATA = original;
    }
  });

  test("transcript path uses %TEMP% and includes uuid", () => {
    const originalTemp = process.env.TEMP;
    process.env.TEMP = "C:\\TestTemp";
    try {
      const p = transcriptPath("11111111-2222-3333-4444-555555555555");
      assert.equal(p, "C:\\TestTemp\\x64dbg-mcp-elevated-11111111-2222-3333-4444-555555555555.log");
    } finally {
      process.env.TEMP = originalTemp;
    }
  });

  test("transcript glob pattern matches transcript file names", () => {
    const pattern = transcriptGlobPattern();
    assert.equal(pattern, "x64dbg-mcp-elevated-*.log");
  });
});
