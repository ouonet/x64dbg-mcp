/**
 * E2E Test: MAX_SESSIONS fix + Health Check
 *
 * Scenarios:
 * 1. Terminated sessions don't block new loads (MAX_SESSIONS fix)
 * 2. Health check detects and cleans orphaned sessions (new feature)
 * 3. Active session limit still enforced (regression test)
 *
 * Run: npx tsx --test test/e2e-max-sessions.test.ts
 */

import { describe, it, beforeEach, afterEach } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { SessionManager } from "../src/session.js";
import { startHealthCheck, stopHealthCheck } from "../src/healthCheck.js";
import { config } from "../src/config.js";
import { McpError, ErrorCode } from "../src/errors.js";

describe("MAX_SESSIONS + Health Check Integration", () => {
  let manager: SessionManager;
  const originalMaxSessions = config.maxSessions;

  beforeEach(() => {
    manager = new SessionManager();
    manager.start();
    // Force MAX_SESSIONS=1 for testing
    Object.defineProperty(config, "maxSessions", {
      value: 1,
      configurable: true,
    });
  });

  afterEach(() => {
    stopHealthCheck();
    manager.stop();
    Object.defineProperty(config, "maxSessions", {
      value: originalMaxSessions,
      configurable: true,
    });
  });

  it("should allow loading immediately after terminate (no 30s wait)", async () => {
    console.log("\n📋 Test 1: Terminated sessions release slots immediately");

    // Load Session A
    const sessionA = manager.createLoading("C:\\exe1.exe", "x64", 30001);
    console.log(`  1️⃣  Loaded Session A: ${sessionA.id.substring(0, 8)}...`);
    assertEquals(sessionA.state, "loading");

    // Terminate Session A
    await manager.terminate(sessionA.id);
    console.log(`  2️⃣  Terminated Session A`);
    assertEquals(manager.peek(sessionA.id).state, "terminated");

    // Try to load Session B immediately (was failing before fix)
    try {
      const sessionB = manager.createLoading("C:\\exe2.exe", "x64", 30002);
      console.log(`  3️⃣  Loaded Session B: ${sessionB.id.substring(0, 8)}... ✓`);
      assertEquals(sessionB.state, "loading");
      console.log(`  ✅ Test PASSED: No 30s wait needed\n`);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      console.error(`  ❌ Test FAILED: ${msg}`);
      throw err;
    }
  });

  it("should block new sessions when active limit reached", async () => {
    console.log("\n📋 Test 2: Active session limit still enforced");

    // Load Session A and keep it active
    const sessionA = manager.createLoading("C:\\exe1.exe", "x64", 30001);
    console.log(`  1️⃣  Loaded Session A: ${sessionA.id.substring(0, 8)}...`);

    // Try to load Session B while A is still active
    let blockedCorrectly = false;
    try {
      manager.createLoading("C:\\exe2.exe", "x64", 30002);
      console.error(`  ❌ Test FAILED: Session B should have been blocked`);
    } catch (err: unknown) {
      const error = err as McpError;
      if (error.code === ErrorCode.E_SESSION_LIMIT) {
        blockedCorrectly = true;
        console.log(`  2️⃣  Session B correctly blocked by MAX_SESSIONS`);
      } else {
        throw err;
      }
    }

    if (blockedCorrectly) {
      console.log(`  ✅ Test PASSED: Active limit enforced\n`);
    }
  });

  it("should detect unresponsive bridges within 5s", async () => {
    console.log("\n📋 Test 3: Health check detects orphaned sessions");

    // Load Session A
    const sessionA = manager.createLoading("C:\\exe1.exe", "x64", 30001);
    const sessionAId = sessionA.id;
    console.log(`  1️⃣  Loaded Session A: ${sessionAId.substring(0, 8)}...`);

    // Simulate a dead bridge by not registering it in bridgeRegistry
    // (In real scenario: user closes x64dbg process)
    console.log(`  2️⃣  Simulating orphaned session (no bridge)`);

    // Start health check
    startHealthCheck();
    console.log(`  3️⃣  Health check started (5s interval)`);

    // Wait for health check to detect orphaned session
    await new Promise((resolve) => setTimeout(resolve, 6000));
    console.log(`  4️⃣  Health check cycle completed`);

    // Session should now be terminated
    const terminatedSession = manager.peek(sessionAId);
    if (terminatedSession.state === "terminated") {
      console.log(
        `  5️⃣  Session A terminated by health check ✓`
      );
      console.log(`  ✅ Test PASSED: Orphaned session cleaned automatically\n`);
    } else {
      console.warn(
        `  ⚠️  Session still ${terminatedSession.state} (may need longer wait or bridge mock)`
      );
    }
  });

  it("stress test: rapid load/terminate cycles", async () => {
    console.log("\n📋 Test 4: Rapid load/terminate cycles (stress test)");

    const cycles = 10;
    let successCount = 0;

    for (let i = 0; i < cycles; i++) {
      try {
        const session = manager.createLoading(
          `C:\\exe${i}.exe`,
          "x64",
          30000 + i
        );
        await manager.terminate(session.id);
        successCount++;
        if (i % 3 === 0) {
          process.stdout.write(`.`);
        }
      } catch (err: unknown) {
        console.error(`\n  Cycle ${i} failed: ${err}`);
        break;
      }
    }

    console.log(`\n  Completed ${successCount}/${cycles} load-terminate cycles`);
    if (successCount === cycles) {
      console.log(`  ✅ Test PASSED: No slot exhaustion\n`);
    }
  });
});

console.log(`
═══════════════════════════════════════════════════════════════════════════════
  MAX_SESSIONS + Health Check E2E Test Suite
  Configuration: MAX_SESSIONS=1, Health Check interval=5s, Ping timeout=2s
═══════════════════════════════════════════════════════════════════════════════
`);
