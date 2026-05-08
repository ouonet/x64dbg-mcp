import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseServiceArgs } from "../../src/service/router.js";

describe("service CLI parsing", () => {
  test("install accepts --port, --host, --elevate", () => {
    const parsed = parseServiceArgs(["install", "--port", "3602", "--host", "127.0.0.1", "--elevate"]);
    assert.equal(parsed.command, "install");
    assert.equal(parsed.options.port, 3602);
    assert.equal(parsed.options.host, "127.0.0.1");
    assert.equal(parsed.options.elevate, true);
  });

  test("install applies defaults when flags omitted", () => {
    const parsed = parseServiceArgs(["install"]);
    assert.equal(parsed.command, "install");
    assert.equal(parsed.options.port, 3602);
    assert.equal(parsed.options.host, "127.0.0.1");
    assert.equal(parsed.options.elevate, false);
    assert.equal(parsed.options.startType, "auto");
    assert.equal(parsed.options.displayName, "x64dbg MCP Server");
  });

  test("install rejects invalid port", () => {
    assert.throws(() => parseServiceArgs(["install", "--port", "99999"]), /port/i);
    assert.throws(() => parseServiceArgs(["install", "--port", "abc"]), /port/i);
  });

  test("install accepts --start delayed-auto", () => {
    const parsed = parseServiceArgs(["install", "--start", "delayed-auto"]);
    assert.equal(parsed.options.startType, "delayed-auto");
  });

  test("install rejects unknown --start value", () => {
    assert.throws(() => parseServiceArgs(["install", "--start", "weird"]), /start/i);
  });

  test("uninstall/start/stop/restart accept --elevate", () => {
    for (const cmd of ["uninstall", "start", "stop", "restart"] as const) {
      const parsed = parseServiceArgs([cmd, "--elevate"]);
      assert.equal(parsed.command, cmd);
      assert.equal(parsed.options.elevate, true);
    }
  });

  test("status takes no flags", () => {
    const parsed = parseServiceArgs(["status"]);
    assert.equal(parsed.command, "status");
  });

  test("rejects unknown subcommand", () => {
    assert.throws(() => parseServiceArgs(["fly"]), /unknown/i);
  });

  test("rejects unknown flag", () => {
    assert.throws(() => parseServiceArgs(["install", "--bogus"]), /unknown/i);
  });

  test("install accepts --transcript (internal flag from elevation)", () => {
    const parsed = parseServiceArgs(["install", "--transcript", "C:\\Temp\\x.log"]);
    assert.equal(parsed.options.transcript, "C:\\Temp\\x.log");
  });

  test("install accepts --display-name and --log-dir", () => {
    const parsed = parseServiceArgs(["install", "--display-name", "Custom Name", "--log-dir", "C:\\custom\\logs"]);
    assert.equal(parsed.options.displayName, "Custom Name");
    assert.equal(parsed.options.logDir, "C:\\custom\\logs");
  });
});
