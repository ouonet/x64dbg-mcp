import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isAdmin, renderPrivilegeError } from "../../src/service/privilege.js";

describe("privilege", () => {
  test("isAdmin returns boolean on win32, false on other platforms", () => {
    const result = isAdmin();
    assert.equal(typeof result, "boolean");
    if (process.platform !== "win32") {
      assert.equal(result, false);
    }
  });

  test("renderPrivilegeError mentions the suggested re-run command", () => {
    const text = renderPrivilegeError("service install --port 3602");
    assert.match(text, /administrator privileges/i);
    assert.match(text, /x64dbg-mcp service install --port 3602/);
    assert.match(text, /--elevate/);
  });
});
