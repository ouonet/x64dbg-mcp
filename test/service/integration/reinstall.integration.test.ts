import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { shouldSkip, runCli, ensureUninstalled } from "./_helpers.js";

test("install on an already-installed service exits 3; reinstall after uninstall succeeds", async (t) => {
  const skip = shouldSkip();
  if (skip.skip) {
    t.skip(skip.reason);
    return;
  }

  before(() => ensureUninstalled());
  after(() => ensureUninstalled());

  const port = 13603;

  let r = runCli(["service", "install", "--port", String(port)]);
  assert.equal(r.status, 0, `first install: ${r.stderr}`);

  r = runCli(["service", "install", "--port", String(port)]);
  assert.equal(r.status, 3, "second install should exit 3");
  assert.match(r.stderr, /already installed/i);

  r = runCli(["service", "uninstall"]);
  assert.equal(r.status, 0);

  r = runCli(["service", "install", "--port", String(port)]);
  assert.equal(r.status, 0, `reinstall after uninstall: ${r.stderr}`);
});
