import crypto from "crypto";
import fs from "fs";
import path from "path";

export const BRIDGE_AUTH_TOKEN_KEY = "BRIDGE_AUTH_TOKEN";
export const BRIDGE_AUTH_TOKEN_FILE = "x64dbg_mcp_bridge.token";

export function generateBridgeAuthToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function ensureBridgeAuthToken(env) {
  const existing = env.get(BRIDGE_AUTH_TOKEN_KEY)?.trim();
  if (existing) {
    return { token: existing, created: false };
  }

  const token = generateBridgeAuthToken();
  env.set(BRIDGE_AUTH_TOKEN_KEY, token);
  return { token, created: true };
}

export function writeBridgeTokenFile(filePath, token) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const current = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").trim()
    : "";

  if (current === token) {
    return false;
  }

  fs.writeFileSync(filePath, `${token}\n`, "utf8");
  return true;
}