import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readInstalledRecord,
  writeInstalledRecord,
  removeInstalledRecord,
} from "../../src/service/installed-json.js";
import type { InstalledRecord } from "../../src/service/types.js";

function makeTempProgramData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "x64dbg-mcp-test-"));
}

describe("installed.json", () => {
  test("returns null when file is missing", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      assert.equal(readInstalledRecord(), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("writes then reads a record", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      const record: InstalledRecord = {
        installPath: "C:\\foo\\dist\\server.js",
        port: 3602,
        host: "127.0.0.1",
        version: "1.2.0",
        installedAt: "2026-05-08T00:00:00Z",
        displayName: "x64dbg MCP Server",
        startType: "auto",
      };
      writeInstalledRecord(record);
      const read = readInstalledRecord();
      assert.deepEqual(read, record);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("remove deletes the file and is idempotent", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      const record: InstalledRecord = {
        installPath: "C:\\x",
        port: 3602,
        host: "127.0.0.1",
        version: "1.0.0",
        installedAt: "2026-05-08T00:00:00Z",
        displayName: "x64dbg MCP Server",
        startType: "auto",
      };
      writeInstalledRecord(record);
      removeInstalledRecord();
      assert.equal(readInstalledRecord(), null);
      removeInstalledRecord(); // idempotent
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns null and logs on malformed JSON", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      const dir = path.join(tmp, "x64dbg-mcp", "service");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "installed.json"), "{not json", "utf8");
      assert.equal(readInstalledRecord(), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
