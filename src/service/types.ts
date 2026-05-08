export type StartType = "auto" | "delayed-auto" | "manual";

export interface ServiceConfig {
  name: string;
  displayName: string;
  port: number;
  host: string;
  startType: StartType;
  logDir: string;
}

export interface InstalledRecord {
  installPath: string;
  port: number;
  host: string;
  version: string;
  installedAt: string;
  displayName: string;
  startType: StartType;
}

export type ServiceState = "RUNNING" | "STOPPED" | "START_PENDING" | "STOP_PENDING" | "PAUSED" | "UNKNOWN";

export interface ScmQueryResult {
  installed: boolean;
  state: ServiceState;
  pid?: number;
  startedAt?: string;
  identityAccount: string;
  scmStartType: StartType;
}

export interface HealthResult {
  ok: boolean;
  durationMs?: number;
  reason?: string;
}

export interface StatusViewModel {
  name: string;
  installed: boolean;
  scm?: ScmQueryResult;
  record?: InstalledRecord;
  health?: HealthResult;
  endpoint?: string;
  packageVersion?: string;
}

export const SERVICE_NAME = "x64dbg-mcp";
export const SERVICE_DEFAULT_DISPLAY_NAME = "x64dbg MCP Server";
export const SERVICE_DEFAULT_PORT = 3602;
export const SERVICE_DEFAULT_HOST = "127.0.0.1";
export const SERVICE_DEFAULT_START_TYPE: StartType = "auto";
