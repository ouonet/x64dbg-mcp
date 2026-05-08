import http from "node:http";
import { performance } from "node:perf_hooks";
import type { HealthResult } from "./types.js";

export interface HealthCheckOptions {
  host: string;
  port: number;
  path?: string;
  timeoutMs?: number;
}

const INITIALIZE_PAYLOAD = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "x64dbg-mcp-health", version: "0" },
  },
};

export function checkHealth(options: HealthCheckOptions): Promise<HealthResult> {
  const { host, port, path = "/mcp", timeoutMs = 5000 } = options;
  const body = JSON.stringify(INITIALIZE_PAYLOAD);
  const start = performance.now();

  return new Promise<HealthResult>((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.on("data", () => {});
        res.on("end", () => {
          const durationMs = Math.round(performance.now() - start);
          if (status >= 200 && status < 300) {
            resolve({ ok: true, durationMs });
          } else {
            resolve({ ok: false, durationMs, reason: `HTTP ${status}` });
          }
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy(new Error("timeout"));
    }, timeoutMs);

    req.on("error", (err: Error) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - start);
      const message = err.message || "unknown error";
      resolve({ ok: false, durationMs, reason: message });
    });

    req.on("close", () => clearTimeout(timer));

    req.write(body);
    req.end();
  });
}
