/**
 * Standard error codes for x64dbg MCP Server.
 *
 * Use these as the `code` property of thrown errors so callers and tests
 * can match on a stable string rather than a free-form message.
 *
 * Example:
 *   const err = new McpError(ErrorCode.E_NOT_DEBUGGING, "Debugger is not running");
 */

// ─── Error code constants ────────────────────────────────────────────────────

export const ErrorCode = {
  /** No active session or debugger is not running. */
  E_NOT_DEBUGGING: "E_NOT_DEBUGGING",
  /** The supplied address is null, out of range, or otherwise invalid. */
  E_INVALID_ADDR: "E_INVALID_ADDR",
  /** The requested session ID was not found. */
  E_SESSION_NOT_FOUND: "E_SESSION_NOT_FOUND",
  /** Maximum session limit reached. */
  E_SESSION_LIMIT: "E_SESSION_LIMIT",
  /** The TCP bridge is not connected. */
  E_BRIDGE_DISCONNECTED: "E_BRIDGE_DISCONNECTED",
  /** A bridge or tool operation timed out. */
  E_TIMEOUT: "E_TIMEOUT",
  /** Authentication token is missing or does not match. */
  E_UNAUTHORIZED: "E_UNAUTHORIZED",
  /** The debuggee is currently running; the operation requires it to be paused. */
  E_NOT_PAUSED: "E_NOT_PAUSED",
  /** The supplied module name was not found in the debuggee. */
  E_MODULE_NOT_FOUND: "E_MODULE_NOT_FOUND",
  /** No free TCP port could be allocated for a new bridge. */
  E_PORT_EXHAUSTED: "E_PORT_EXHAUSTED",
  /** Bridge protocol version does not match (added in v1.2.0). */
  E_PROTOCOL_VERSION: "E_PROTOCOL_VERSION",
  /** Operation attempted on a session in terminated state (added in v1.2.0). */
  E_SESSION_TERMINATED: "E_SESSION_TERMINATED",
  /** File I/O failed in save_memory_dump / create_minidump (added in v1.2.0). */
  E_IO_FAILED: "E_IO_FAILED",
  /** A supplied argument is invalid (path, size, etc.) (added in v1.2.0). */
  E_INVALID_ARGUMENT: "E_INVALID_ARGUMENT",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Structured error class ──────────────────────────────────────────────────

export class McpError extends Error {
  readonly code: ErrorCodeValue;

  constructor(code: ErrorCodeValue, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}
