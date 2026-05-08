import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeServiceEnv } from "../../src/service/env-file.js";

function makeTempProgramData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "x64dbg-mcp-env-"));
}

describe("env-file", () => {
  test("creates new .env with MCP keys when none exists", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      mergeServiceEnv({ host: "127.0.0.1", port: 3602 });
      const content = fs.readFileSync(path.join(tmp, "x64dbg-mcp", ".env"), "utf8");
      assert.match(content, /^MCP_TRANSPORT=streamable-http$/m);
      assert.match(content, /^MCP_HTTP_HOST=127\.0\.0\.1$/m);
      assert.match(content, /^MCP_HTTP_PORT=3602$/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("preserves unrelated keys when merging", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      const envPath = path.join(tmp, "x64dbg-mcp", ".env");
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.writeFileSync(envPath, "X64DBG_PATH=C:\\custom\\x64dbg\nMAX_SESSIONS=10\n", "utf8");

      mergeServiceEnv({ host: "0.0.0.0", port: 4000 });

      const content = fs.readFileSync(envPath, "utf8");
      assert.match(content, /^X64DBG_PATH=C:\\custom\\x64dbg$/m);
      assert.match(content, /^MAX_SESSIONS=10$/m);
      assert.match(content, /^MCP_HTTP_HOST=0\.0\.0\.0$/m);
      assert.match(content, /^MCP_HTTP_PORT=4000$/m);
      assert.match(content, /^MCP_TRANSPORT=streamable-http$/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("overwrites existing MCP_* keys", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      const envPath = path.join(tmp, "x64dbg-mcp", ".env");
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.writeFileSync(envPath, "MCP_HTTP_PORT=9999\nMCP_TRANSPORT=stdio\n", "utf8");

      mergeServiceEnv({ host: "127.0.0.1", port: 3602 });

      const content = fs.readFileSync(envPath, "utf8");
      assert.match(content, /^MCP_HTTP_PORT=3602$/m);
      assert.match(content, /^MCP_TRANSPORT=streamable-http$/m);
      assert.doesNotMatch(content, /^MCP_HTTP_PORT=9999$/m);
      assert.doesNotMatch(content, /^MCP_TRANSPORT=stdio$/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("preserves comments and blank lines", () => {
    const tmp = makeTempProgramData();
    process.env.PROGRAMDATA = tmp;
    try {
      const envPath = path.join(tmp, "x64dbg-mcp", ".env");
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      const original = "# header comment\n\nLOG_LEVEL=debug\n\n# trailing\n";
      fs.writeFileSync(envPath, original, "utf8");

      mergeServiceEnv({ host: "127.0.0.1", port: 3602 });

      const content = fs.readFileSync(envPath, "utf8");
      assert.match(content, /^# header comment$/m);
      assert.match(content, /^LOG_LEVEL=debug$/m);
      assert.match(content, /^# trailing$/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
