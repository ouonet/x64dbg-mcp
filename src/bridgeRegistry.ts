/**
 * Per-session BridgeClient registry. Each debugging session owns a single
 * BridgeClient connected to its dedicated x64dbg instance.
 *
 * The registry binds disconnect/reconnect events with the session id in
 * scope so a dead bridge can drive its own session's cleanup.
 */

import { BridgeClient } from "./bridge.js";
import { logger } from "./logger.js";
import { McpError, ErrorCode } from "./errors.js";

export class BridgeRegistry {
  private clients = new Map<string, BridgeClient>();

  set(sessionId: string, client: BridgeClient): void {
    client.on("disconnected", () => {
      logger.error(
        `Bridge for session ${sessionId} disconnected — terminating session`,
      );
      // Lazy import to avoid circular dep with session.ts
      void import("./session.js").then(({ sessions }) => {
        try {
          void sessions.terminate(sessionId);
        } catch {
          /* already gone */
        }
      });
    });

    client.on("reconnected", () => {
      logger.info(`Bridge for session ${sessionId} reconnected`);
    });

    this.clients.set(sessionId, client);
  }

  get(sessionId: string): BridgeClient {
    const c = this.clients.get(sessionId);
    if (!c) {
      throw new McpError(
        ErrorCode.E_SESSION_NOT_FOUND,
        `No bridge for session ${sessionId}`,
      );
    }
    return c;
  }

  has(sessionId: string): boolean {
    return this.clients.has(sessionId);
  }

  async delete(sessionId: string): Promise<void> {
    const c = this.clients.get(sessionId);
    if (!c) return;
    this.clients.delete(sessionId);
    try {
      await c.drain(2_000);
    } catch {
      /* ignore drain failure */
    }
    try {
      await c.disconnect();
    } catch {
      /* ignore disconnect failure */
    }
  }

  list(): BridgeClient[] {
    return Array.from(this.clients.values());
  }
}

/** Process-wide registry. */
export const bridges = new BridgeRegistry();

/** Shorthand for the most common lookup pattern: `bridgeFor(sessionId).call(...)`. */
export function bridgeFor(sessionId: string): BridgeClient {
  return bridges.get(sessionId);
}
