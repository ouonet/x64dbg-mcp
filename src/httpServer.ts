import http, { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "./logger.js";

type SessionEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

export interface HttpMcpServerOptions {
  host: string;
  port: number;
  path: string;
  createServer: () => McpServer;
}

export interface StartedHttpMcpServer {
  host: string;
  port: number;
  path: string;
  server: http.Server;
  close: () => Promise<void>;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  id: unknown = null
): void {
  if (res.headersSent) return;

  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: statusCode >= 500 ? -32603 : -32000,
        message,
      },
      id,
    })
  );
}

function writePlainError(res: ServerResponse, statusCode: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON request body");
  }
}

function matchesPath(req: IncomingMessage, expectedPath: string): boolean {
  const host = req.headers.host || "127.0.0.1";
  const url = new URL(req.url || "/", `http://${host}`);
  return url.pathname === expectedPath;
}

async function closeSession(sessionId: string, sessions: Map<string, SessionEntry>): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;

  sessions.delete(sessionId);

  try {
    await entry.transport.close();
  } catch (error) {
    logger.warn(`Failed to close HTTP transport for session ${sessionId}: ${error}`);
  }

  try {
    await entry.server.close();
  } catch (error) {
    logger.warn(`Failed to close MCP server for session ${sessionId}: ${error}`);
  }
}

export async function startHttpMcpServer(
  options: HttpMcpServerOptions
): Promise<StartedHttpMcpServer> {
  const sessions = new Map<string, SessionEntry>();

  const server = http.createServer(async (req, res) => {
    try {
      if (!matchesPath(req, options.path)) {
        writePlainError(res, 404, "Not Found");
        return;
      }

      const sessionId = getHeaderValue(req.headers["mcp-session-id"]);

      if (req.method === "POST") {
        const parsedBody = await readJsonBody(req);
        const existingSession = sessionId ? sessions.get(sessionId) : undefined;

        if (existingSession) {
          await existingSession.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (sessionId) {
          writeJsonRpcError(res, 404, `Session not found: ${sessionId}`);
          return;
        }

        if (!isInitializeRequest(parsedBody)) {
          writeJsonRpcError(res, 400, "Bad Request: initial HTTP requests must be initialize requests");
          return;
        }

        const mcpServer = options.createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { server: mcpServer, transport });
            logger.info(`HTTP MCP session initialized: ${newSessionId}`);
          },
        });
        transport.onerror = (error) => {
          logger.error(`HTTP MCP transport error: ${error.message}`);
        };
        transport.onclose = () => {
          const activeSessionId = transport.sessionId;
          if (!activeSessionId) return;
          void closeSession(activeSessionId, sessions);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "GET") {
        if (!sessionId || !sessions.has(sessionId)) {
          writePlainError(res, 400, "Invalid or missing session ID");
          return;
        }

        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        if (!sessionId || !sessions.has(sessionId)) {
          writePlainError(res, 400, "Invalid or missing session ID");
          return;
        }

        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405, { Allow: "POST, GET, DELETE" });
      res.end("Method Not Allowed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to handle HTTP MCP request: ${message}`);

      if (req.method === "POST") {
        writeJsonRpcError(res, 500, "Internal server error");
      } else {
        writePlainError(res, 500, "Internal server error");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve HTTP server listening address");
  }

  return {
    server,
    host: address.address,
    port: address.port,
    path: options.path,
    close: async () => {
      const activeSessionIds = [...sessions.keys()];
      await Promise.all(activeSessionIds.map((sessionId) => closeSession(sessionId, sessions)));

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}