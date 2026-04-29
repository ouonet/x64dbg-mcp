import crypto from "crypto";
import fs from "fs";
import path from "path";

export const BRIDGE_AUTH_TOKEN_KEY = "BRIDGE_AUTH_TOKEN";
export const BRIDGE_AUTH_TOKEN_FILE = "x64dbg_mcp_bridge.token";

export function generateBridgeAuthToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeBridgeToken(token) {
  return String(token || "").replace(/^\uFEFF/, "").trim();
}

export function ensureBridgeAuthToken(env) {
  const existing = normalizeBridgeToken(env.get(BRIDGE_AUTH_TOKEN_KEY));
  if (existing) {
    return { token: existing, created: false };
  }

  const token = generateBridgeAuthToken();
  env.set(BRIDGE_AUTH_TOKEN_KEY, token);
  return { token, created: true };
}

export function writeBridgeTokenFile(filePath, token) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const rawCurrent = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8")
    : "";
  const current = normalizeBridgeToken(rawCurrent);
  const normalizedToken = normalizeBridgeToken(token);
  const needsRewrite = rawCurrent.startsWith("\uFEFF") || rawCurrent !== `${normalizedToken}\n`;

  if (current === normalizedToken && !needsRewrite) {
    return false;
  }

  fs.writeFileSync(filePath, `${normalizedToken}\n`, "utf8");
  return true;
}