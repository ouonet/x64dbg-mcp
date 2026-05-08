import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseServiceArgs } from "../../src/service/router.js";

describe("error codes contract", () => {
  test("parser throws (caller maps to exit 1) on unknown subcommand", () => {
    assert.throws(() => parseServiceArgs(["bogus"]), /unknown/i);
  });

  test("parser throws on invalid port", () => {
    assert.throws(() => parseServiceArgs(["install", "--port", "0"]), /port/i);
  });

  // Exit-code mapping for runtime errors (privilege/conflict/port) is verified
  // in integration tests because they involve real SCM and fs state.
});
