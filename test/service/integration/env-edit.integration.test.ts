import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shouldSkip, runCli, ensureUninstalled } from "./_helpers.js";
import { serviceEnvFile } from "../../../src/service/paths.js";

test(".env edit takes effect on restart", async (t) => {
  const skip = shouldSkip();
  if (skip.skip) {
    t.skip(skip.reason);
    return;
  }

  before(() => ensureUninstalled());
  after(() => ensureUninstalled());

  const port = 13605;
  let r = runCli(["service", "install", "--port", String(port)]);
  assert.equal(r.status, 0, `install: ${r.stderr}`);

  // Append a non-MCP_* key.
  const beforeContent = fs.readFileSync(serviceEnvFile(), "utf8");
  fs.writeFileSync(serviceEnvFile(), `${beforeContent.trimEnd()}\nMAX_SESSIONS=7\n`, "utf8");

  r = runCli(["service", "start"]);
  assert.equal(r.status, 0, `start: ${r.stderr}`);

  await new Promise((res) => setTimeout(res, 3000));

  r = runCli(["service", "restart"]);
  assert.equal(r.status, 0, `restart: ${r.stderr}`);

  const afterContent = fs.readFileSync(serviceEnvFile(), "utf8");
  assert.match(afterContent, /^MAX_SESSIONS=7$/m);

  r = runCli(["service", "stop"]);
  assert.equal(r.status, 0);
});
