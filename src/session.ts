/**
 * Session manager — tracks active x64dbg debugging sessions.
 */

import crypto from "crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { bridge } from "./bridge.js";
import { ErrorCode, McpError } from "./errors.js";
import type { Session, DebugState, Breakpoint, ModuleInfo } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.gcTimer = setInterval(
      () => this.collectExpired(),
      Math.min(config.sessionTimeoutMs / 2, 60_000)
    );
  }

  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    for (const id of this.sessions.keys()) {
      this.terminate(id);
    }
    this.sessions.clear();
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  create(executable: string, architecture: "x86" | "x64", pid: number): Session {
    if (this.sessions.size >= 1) {
      throw new McpError(
        ErrorCode.E_SESSION_LIMIT,
        "Only one active debugging session is supported. Terminate the current session before loading a new executable."
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const session: Session = {
      id,
      pid,
      executable,
      architecture,
      state: "idle",
      createdAt: now,
      lastActivity: now,
      breakpoints: new Map(),
      modules: [],
    };

    this.sessions.set(id, session);
    logger.info(`Session created: ${id} → ${executable} (${architecture})`);
    return session;
  }

  /**
   * Look up a session by ID.
   * NOTE: intentionally updates lastActivity so that sessions actively in use
   * are not reaped by the GC. If you need a read-only lookup without touching
   * the timer, use peek().
   */
  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new McpError(ErrorCode.E_SESSION_NOT_FOUND, `Session not found: ${id}`);
    s.lastActivity = Date.now();
    return s;
  }

  /**
   * Look up a session by ID without updating lastActivity.
   * Use this for read-only operations (e.g. get_status) where touching the
   * idle timer is undesirable.
   */
  peek(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new McpError(ErrorCode.E_SESSION_NOT_FOUND, `Session not found: ${id}`);
    return s;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  updateState(id: string, state: DebugState): void {
    const s = this.get(id);
    s.state = state;
    s.lastActivity = Date.now();
    logger.debug(`Session ${id} state → ${state}`);
  }

  setModules(id: string, modules: ModuleInfo[]): void {
    const s = this.get(id);
    s.modules = modules;
  }

  addBreakpoint(id: string, bp: Breakpoint): void {
    const s = this.get(id);
    s.breakpoints.set(bp.address, bp);
  }

  removeBreakpoint(id: string, address: string): void {
    const s = this.get(id);
    s.breakpoints.delete(address);
  }

  terminate(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;

    s.state = "terminated";
    this.sessions.delete(id);
    logger.info(`Session terminated: ${id}`);
  }

  // ── Housekeeping ────────────────────────────────────────────────────────

  private collectExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > config.sessionTimeoutMs) {
        logger.warn(`Session ${id} expired (idle > ${config.sessionTimeoutMs}ms)`);
        // Notify the bridge to stop the debuggee before dropping the session
        if (bridge.isConnected) {
          bridge.call("debug.stop", { sessionId: id }).catch((err) => {
            logger.warn(`GC: debug.stop failed for session ${id}: ${err}`);
          });
        }
        this.terminate(id);
      }
    }
  }

  toJSON(): object[] {
    return this.list().map((s) => ({
      id: s.id,
      pid: s.pid,
      executable: s.executable,
      architecture: s.architecture,
      state: s.state,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
      breakpoints: Array.from(s.breakpoints.values()),
      moduleCount: s.modules.length,
    }));
  }
}

/** Singleton session manager */
export const sessions = new SessionManager();
