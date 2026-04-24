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
