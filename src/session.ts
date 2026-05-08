/**
 * Session manager — tracks active x64dbg debugging sessions.
 *
 * Each session owns its own x64dbg process and bridge connection. terminate()
 * is the canonical full-cleanup path: disconnect bridge → kill x64dbg → drop
 * session entry. GC reuses the same path when an idle session expires.
 */

import crypto from "crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
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
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      void this.terminate(id);
    }
    this.sessions.clear();
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  create(
    executable: string,
    architecture: "x86" | "x64",
    pid: number,
    bridgePort: number,
  ): Session {
    if (this.sessions.size >= config.maxSessions) {
      const active = this.list().map((s) =>
        `${s.id} (${s.executable}, ${s.state})`,
      ).join(", ");
      throw new McpError(
        ErrorCode.E_SESSION_LIMIT,
        `Reached MAX_SESSIONS=${config.maxSessions}. Active sessions: ${active}. ` +
        `Terminate one before loading another executable.`,
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
      bridgePort,
      createdAt: now,
      lastActivity: now,
      breakpoints: new Map(),
      modules: [],
    };

    this.sessions.set(id, session);
    logger.info(
      `Session created: ${id} → ${executable} (${architecture}, port ${bridgePort})`,
    );
    return session;
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new McpError(ErrorCode.E_SESSION_NOT_FOUND, `Session not found: ${id}`);
    s.lastActivity = Date.now();
    return s;
  }

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

  /**
   * Full cleanup: disconnect bridge, kill the owning x64dbg, drop the session.
   * Safe to call repeatedly; missing pieces are tolerated.
   */
  async terminate(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;

    s.state = "terminated";

    // Lazy imports to avoid circular dependencies with bridgeRegistry / launcher.
    try {
      const { bridges } = await import("./bridgeRegistry.js");
      try { await bridges.delete(id); } catch (err) {
        logger.warn(`terminate(${id}): bridge cleanup failed: ${err}`);
      }
    } catch (err) {
      logger.warn(`terminate(${id}): bridgeRegistry import failed: ${err}`);
    }

    try {
      const launcherModule = await import("./launcher.js") as Record<string, unknown>;
      const killFn = launcherModule.killDebuggerForSession as ((sid: string) => void) | undefined;
      if (typeof killFn === "function") {
        try { killFn(id); } catch (err) {
          logger.warn(`terminate(${id}): debugger kill failed: ${err}`);
        }
      }
    } catch (err) {
      logger.warn(`terminate(${id}): launcher import failed: ${err}`);
    }

    this.sessions.delete(id);
    logger.info(`Session terminated: ${id}`);
  }

  // ── Housekeeping ────────────────────────────────────────────────────────

  private collectExpired(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActivity > config.sessionTimeoutMs) {
        logger.warn(`Session ${id} expired (idle > ${config.sessionTimeoutMs}ms)`);
        void this.terminate(id);
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
      bridgePort: s.bridgePort,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActivity: new Date(s.lastActivity).toISOString(),
      breakpoints: Array.from(s.breakpoints.values()),
      moduleCount: s.modules.length,
    }));
  }
}

/** Singleton session manager */
export const sessions = new SessionManager();
