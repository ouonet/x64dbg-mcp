import path from "node:path";

function programDataRoot(): string {
  return process.env.PROGRAMDATA || "C:\\ProgramData";
}

export function serviceRootDir(): string {
  return path.join(programDataRoot(), "x64dbg-mcp");
}

export function serviceWrapperDir(): string {
  return path.join(serviceRootDir(), "service");
}

export function serviceEnvFile(): string {
  return path.join(serviceRootDir(), ".env");
}

export function serviceLogsDir(): string {
  return path.join(serviceRootDir(), "logs");
}

export function serviceShimPath(): string {
  return path.join(serviceWrapperDir(), "x64dbg-mcp-shim.mjs");
}

export function installedJsonPath(): string {
  return path.join(serviceWrapperDir(), "installed.json");
}

function tempRoot(): string {
  return process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
}

export function transcriptPath(uuid: string): string {
  return path.join(tempRoot(), `x64dbg-mcp-elevated-${uuid}.log`);
}

export function transcriptGlobPattern(): string {
  return "x64dbg-mcp-elevated-*.log";
}

export function transcriptDir(): string {
  return tempRoot();
}
