/**
 * Health check — detect dead bridges and orphaned sessions.
 *
 * Periodically verifies that each session's bridge is still responsive.
 * If a bridge fails to respond (x64dbg crashed, socket stalled), immediately
 * terminates the session rather than waiting for GC or socket timeout.
 */

import { sessions } from "./session.js";
import { bridges } from "./bridgeRegistry.js";
import { logger } from "./logger.js";

const HEALTH_CHECK_INTERVAL_MS = 5_000; // Check every 5 seconds
const BRIDGE_PING_TIMEOUT_MS = 2_000; // 2s ping timeout before declaring dead

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthCheck(): void {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(async () => {
    const activeSessions = sessions.list().filter((s) => s.state !== "terminated");

    for (const session of activeSessions) {
      try {
        // Try to get the bridge client
        if (!bridges.has(session.id)) {
          logger.warn(
            `Session ${session.id} is active but has no bridge — terminating`
          );
          await sessions.terminate(session.id);
          continue;
        }

        // Ping the bridge with a lightweight probe
        const bridge = bridges.get(session.id);
        if (!bridge.isConnected) {
          logger.warn(
            `Session ${session.id} bridge is not connected — terminating`
          );
          await sessions.terminate(session.id);
          continue;
        }

        // Send protocol.probe with short timeout
        try {
          const startTime = Date.now();

          // Use Promise.race for timeout
          await Promise.race([
            bridge.call<{ protocolVersion: string }>(
              "protocol.probe",
              {}
            ),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Bridge ping timeout")),
                BRIDGE_PING_TIMEOUT_MS
              )
            ),
          ]);

          const elapsed = Date.now() - startTime;

          if (elapsed > BRIDGE_PING_TIMEOUT_MS * 0.8) {
            logger.warn(
              `Session ${session.id} bridge responded slowly (${elapsed}ms) — monitoring`
            );
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            `Session ${session.id} bridge is unresponsive (${msg}) — terminating`
          );
          await sessions.terminate(session.id);
        }
      } catch (err: unknown) {
        logger.error(`Health check failed for session ${session.id}: ${err}`);
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  logger.info(
    `Health check started (interval=${HEALTH_CHECK_INTERVAL_MS}ms, ping timeout=${BRIDGE_PING_TIMEOUT_MS}ms)`
  );
}

export function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
    logger.info("Health check stopped");
  }
}
