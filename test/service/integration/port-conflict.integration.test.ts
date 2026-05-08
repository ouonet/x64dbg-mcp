import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { shouldSkip, runCli, ensureUninstalled } from "./_helpers.js";

test("install fails with exit 4 when port is already bound", async (t) => {
  const skip = shouldSkip();
  if (skip.skip) {
    t.skip(skip.reason);
    return;
  }

  before(() => ensureUninstalled());
  after(() => ensureUninstalled());

  const port = 13604;

  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", () => resolve()));

  try {
    const r = runCli(["service", "install", "--port", String(port)]);
    assert.equal(r.status, 4, `expected exit 4, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /already in use/i);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }

  // Verify SCM has no entry for x64dbg-mcp (idempotent failure).
  const status = runCli(["service", "status"]);
  assert.match(status.stdout, /\(not installed\)/);
});
