/**
 * Session manager — tracks active x64dbg debugging sessions.
 *
 * Each session owns its own x64dbg process and bridge connection. terminate()
 * is the canonical full-cleanup path: disconnect bridge → kill x64dbg → drop
 * session entry. GC reuses the same path when an idle session expires.
 */

import crypto from "crypto";
import { EventEmitter } from "events";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { ErrorCode, McpError } from "./errors.js";
import type { Session, DebugState, Breakpoint, ModuleInfo, DebugEvent, PauseReason, TerminationReason } from "./types.js";

/** T8 — D6 per-session state-change condition variable. */
class StateChangeCV {
  private waiters: Array<(woken: boolean) => void> = [];

  signal(): void {
    const ws = this.waiters.splice(0);
    for (const wake of ws) wake(true);
  }

  wait(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const wake = (woken: boolean): void => {
        if (!done) { done = true; resolve(woken); }
      };
      this.waiters.push(wake);
      setTimeout(() => {
        const idx = this.waiters.indexOf(wake);
        if (idx >= 0) this.waiters.splice(idx, 1);
        wake(false);
      }, timeoutMs);
    });
  }
}

const TERMINATED_RETENTION_MS = 30_000;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private stateCVs = new Map<string, StateChangeCV>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  // T9 — injectable clock for fast-clock tests.
  private _now: () => number = Date.now;

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
      // D2: sessions are created post-`debug.load`, so the debuggee is paused
      // at the entry point. Bridge events (T8) will drive subsequent transitions.
      state: "paused",
      pauseReason: "system_breakpoint",
      terminationReason: null,
      lastEvent: null,
      recentEvents: [],
      bridgePort,
      createdAt: now,
      lastActivity: now,
      breakpoints: new Map(),
      modules: [],
    };

    this.sessions.set(id, session);
    this.stateCVs.set(id, new StateChangeCV());
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

  // ── T8: event wiring + state-change CV (D2, D4, D6) ─────────────────────

  applyDebugEvent(id: string, event: DebugEvent): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.lastEvent = event;
    s.recentEvents.push(event);
    if (s.recentEvents.length > 50) s.recentEvents.shift();
    s.lastActivity = Date.now();
  }

  applyStateChange(id: string, bridgeState: {
    state: DebugState;
    pauseReason: PauseReason | null;
    terminationReason: TerminationReason | null;
  }): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.state = bridgeState.state;
    s.pauseReason = bridgeState.pauseReason;
    s.terminationReason = bridgeState.terminationReason;
    s.lastActivity = Date.now();
    this.stateCVs.get(id)?.signal();
  }

  wireClient(id: string, client: EventEmitter): void {
    client.on("debugEvent", (event: DebugEvent) => this.applyDebugEvent(id, event));
    client.on("stateChange", (state: Parameters<SessionManager["applyStateChange"]>[1]) =>
      this.applyStateChange(id, state)
    );
  }

  waitForStateChange(id: string, timeoutMs: number): Promise<boolean> {
    const cv = this.stateCVs.get(id);
    if (!cv) return Promise.resolve(false);
    return cv.wait(timeoutMs);
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
    // T9 — record termination timestamp for 30s retention window.
    // Use _now so tests can inject a fake clock.
    s.terminatedAt = this._now();

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

    // T9 — do NOT delete yet; GC will reap after TERMINATED_RETENTION_MS.
    logger.info(`Session terminated: ${id} (30s retention window starts)`);
  }

  // ── Housekeeping ────────────────────────────────────────────────────────

  private collectExpired(): void {
    const now = this._now();
    for (const [id, s] of this.sessions) {
      if (s.state === "terminated") {
        // T9 — reap terminated sessions after the 30s retention window.
        if (s.terminatedAt !== undefined && now - s.terminatedAt > TERMINATED_RETENTION_MS) {
          logger.info(`Session ${id} retention expired, removing`);
          this.sessions.delete(id);
          this.stateCVs.delete(id);
        }
      } else if (now - s.lastActivity > config.sessionTimeoutMs) {
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
