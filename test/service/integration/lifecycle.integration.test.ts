import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { shouldSkip, runCli, ensureUninstalled } from "./_helpers.js";

test("service lifecycle install → start → status → stop → uninstall", async (t) => {
  const skip = shouldSkip();
  if (skip.skip) {
    t.skip(skip.reason);
    return;
  }

  before(() => ensureUninstalled());
  after(() => ensureUninstalled());

  const port = 13602;

  let r = runCli(["service", "install", "--port", String(port)]);
  assert.equal(r.status, 0, `install: ${r.stderr}`);

  r = runCli(["service", "start"]);
  assert.equal(r.status, 0, `start: ${r.stderr}`);

  // Give the service a moment to fully start.
  await new Promise((res) => setTimeout(res, 3000));

  r = runCli(["service", "status"]);
  assert.equal(r.status, 0, `status: ${r.stderr}`);
  assert.match(r.stdout, /State:\s+RUNNING/);
  assert.match(r.stdout, new RegExp(`Endpoint:\\s+http://127\\.0\\.0\\.1:${port}/mcp`));

  r = runCli(["service", "stop"]);
  assert.equal(r.status, 0, `stop: ${r.stderr}`);

  r = runCli(["service", "uninstall"]);
  assert.equal(r.status, 0, `uninstall: ${r.stderr}`);

  r = runCli(["service", "status"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(not installed\)/);
});
