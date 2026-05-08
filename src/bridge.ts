/**
 * Bridge client — communicates with the x64dbg bridge plugin over TCP.
 *
 * Protocol (newline-delimited JSON):
 *   → { id, method, params }
 *   ← { id, success, data?, error? }
 *
 * The bridge plugin (plugin/x64dbg_mcp_bridge.py) runs inside x64dbg via
 * x64dbgpy and listens on a local TCP port.
 */

import net from "net";
import crypto from "crypto";
import { EventEmitter } from "events";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { launchDebugger } from "./launcher.js";
import type { BridgeRequest, BridgeResponse, BridgeEvent } from "./types.js";
import { BRIDGE_PROTOCOL_VERSION } from "./types.js";

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_BASE_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 20;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024; // 16 MB — accommodate large trace/search responses

type PendingResolver = {
  resolve: (value: BridgeResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pending = new Map<string, PendingResolver>();
  private connected = false;
  private connecting = false; // guard against concurrent connect() calls
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: string = config.bridgeHost,
    private readonly port: number = config.bridgePort,
  ) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get bridgePort(): number {
    return this.port;
  }

  // ── Connection management ───────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) return;
    // Prevent concurrent connect() calls from creating multiple sockets
    if (this.connecting) {
      return new Promise<void>((resolve, reject) => {
        this.once("connected-result", (err?: Error) => {
          if (err) reject(err); else resolve();
        });
      });
    }
    this.connecting = true;

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connecting = false;
        this.cleanup();
        const err = new Error("Bridge connection timed out");
        this.emit("connected-result", err);
        reject(err);
      }, CONNECT_TIMEOUT_MS);

      this.socket = new net.Socket();

      this.socket.on("connect", () => {
        clearTimeout(timer);
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.buffer = "";
        logger.info(`Bridge connected to ${this.host}:${this.port}`);
        this.emit("connected-result");
        resolve();
      });

      this.socket.on("data", (chunk) => this.onData(chunk));

      this.socket.on("error", (err) => {
        clearTimeout(timer);
        logger.error(`Bridge socket error: ${err.message}`);
        if (!this.connected) {
          this.connecting = false;
          this.emit("connected-result", err);
          reject(err);
        }
      });

      this.socket.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.rejectAllPending("Bridge connection closed");
        if (wasConnected) {
          logger.warn("Bridge connection closed, scheduling reconnect");
          this.scheduleReconnect();
        }
      });

      this.socket.connect(this.port, this.host);
    });
  }

  /**
   * Disconnect from the bridge. Returns a Promise that resolves only after
   * the underlying socket emits its `close` event (or after a 500 ms safety
   * timeout), so callers can be certain the file descriptor is released
   * before the process exits.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.rejectAllPending("Bridge disconnecting");

    const sock = this.socket;
    this.socket = null;
    this.connected = false;
    this.connecting = false;

    if (sock && !sock.destroyed) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        sock.once("close", finish);
        // Remove data/error listeners before destroy to silence spurious events
        sock.removeAllListeners("data");
        sock.removeAllListeners("error");
        sock.destroy();
        // Safety: resolve after 500 ms even if close never fires
        setTimeout(finish, 500);
      });
    }

    logger.info("Bridge disconnected");
  }

  private cleanup(): void {
    this.connected = false;
    this.connecting = false;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error("Max reconnect attempts reached");
      this.emit("disconnected");
      return;
    }
    this.reconnectAttempts++;
    // Exponential backoff with a 30 s cap: 2s, 4s, 8s, 16s, 30s, 30s, …
    const delay = Math.min(
      RECONNECT_DELAY_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      30_000
    );
    logger.info(
      `Reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`
    );
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.emit("reconnected");
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  // ── Data handling ───────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");

    // Safety: discard buffer if it grows beyond the hard limit (e.g. bridge sends garbage)
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      logger.error(
        `Bridge buffer exceeded ${MAX_BUFFER_BYTES} bytes — discarding and disconnecting`
      );
      this.buffer = "";
      this.rejectAllPending("Bridge buffer overflow");
      this.cleanup();
      this.scheduleReconnect();
      return;
    }

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        if (msg.event) {
          this.handleEvent(msg as BridgeEvent);
        } else if (msg.id) {
          this.handleResponse(msg as BridgeResponse);
        }
      } catch {
        logger.warn(`Bridge received malformed JSON: ${line}`);
      }
    }
  }

  private handleResponse(res: BridgeResponse): void {
    const entry = this.pending.get(res.id);
    if (!entry) {
      logger.warn(`Bridge received response for unknown request: ${res.id}`);
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(res.id);
    entry.resolve(res);
  }

  private handleEvent(event: BridgeEvent): void {
    logger.debug(`Bridge event: ${event.event}`);
    this.emit("bridge-event", event);
  }

  private rejectAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * Wait for all in-flight requests to settle or until the timeout expires.
   * Call this before disconnect() during graceful shutdown to avoid rejecting
   * requests that are still being processed by the bridge.
   */
  async drain(timeoutMs = 5_000): Promise<void> {
    if (this.pending.size === 0) return;
    return new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, timeoutMs);
      const check = (): void => {
        if (this.pending.size === 0) {
          clearTimeout(deadline);
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      setTimeout(check, 50);
    });
  }

  // ── Public request API ──────────────────────────────────────────────────

  async request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<BridgeResponse> {
    // Auto-reconnect: if disconnected, attempt one reconnect before failing
    if (!this.connected || !this.socket) {
      logger.info(`Bridge not connected, attempting reconnect before ${method}`);
      try {
        await this.connect();
      } catch {
        throw new Error("Bridge is not connected");
      }
    }

    const id = crypto.randomUUID();
    const req: BridgeRequest = { id, method, params, protocolVersion: BRIDGE_PROTOCOL_VERSION };
    if (config.bridgeAuthToken) {
      req.authToken = config.bridgeAuthToken;
    }
    const payload = JSON.stringify(req) + "\n";

    return new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.socket!.write(payload, "utf-8", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Bridge write error: ${err.message}`));
        }
      });
    });
  }

  /**
   * Convenience: send a request and return only the data payload,
   * throwing on bridge-level errors.
   */
  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number
  ): Promise<T> {
    const res = await this.request(method, params, timeoutMs);
    if (!res.success) {
      throw new Error(res.error ?? `Bridge call failed: ${method}`);
    }
    return res.data as T;
  }

  // ── Auto-launch support ──────────────────────────────────────────────

  /**
   * Ensure the bridge is connected. If not, try connecting once.
   * Throws if the connection fails.
   */
  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.connect();
  }

  /**
   * Launch x64dbg with a target executable and connect to the bridge.
   * Auto-detects PE architecture (x86/x64) and spawns the correct debugger.
   * Waits for the bridge plugin to become available, then connects.
   *
   * @returns The detected architecture.
   */
  async launchAndConnect(
    targetExe: string
  ): Promise<"x86" | "x64"> {
    const arch = await launchDebugger(targetExe);
    // Connect to the bridge now that the debugger is running
    await this.connect();
    return arch;
  }
}

/**
 * Singleton bridge instance — DEPRECATED. Kept for transitional compatibility
 * until tools migrate to per-session BridgeClients via BridgeRegistry.
 * Will be removed in a later task once all callers are migrated.
 */
export const bridge = new BridgeClient();
