/**
 * Logging utility — writes to stderr only (required for STDIO MCP transport)
 */

import winston from "winston";
import { config } from "./config.js";

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    winston.format.printf(
      ({ timestamp, level, message, ...meta }) =>
        `[${timestamp}] [${level.toUpperCase()}] ${message}${
          Object.keys(meta).length ? " " + JSON.stringify(meta) : ""
        }`
    )
  ),
  transports: [
    new winston.transports.Stream({ stream: process.stderr }),
  ],
});

/**
 * Log a completed tool invocation with structured fields.
 *
 * @param method     Tool name (e.g. "read_memory")
 * @param sessionId  Active session ID, or empty string if not applicable
 * @param durationMs Wall-clock time for the invocation in milliseconds
 * @param error      Error message if the invocation failed; omit on success
 */
export function logToolCall(
  method: string,
  sessionId: string,
  durationMs: number,
  error?: string
): void {
  const meta: Record<string, unknown> = { method, sessionId, durationMs };
  if (error !== undefined) {
    logger.warn("tool error", { ...meta, error });
  } else {
    logger.debug("tool ok", meta);
  }
}
