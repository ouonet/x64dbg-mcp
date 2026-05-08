import fs from "node:fs";
import { installedJsonPath, serviceWrapperDir } from "./paths.js";
import type { InstalledRecord } from "./types.js";

export function readInstalledRecord(): InstalledRecord | null {
  const file = installedJsonPath();
  if (!fs.existsSync(file)) return null;

  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as InstalledRecord;
  } catch {
    return null;
  }
}

export function writeInstalledRecord(record: InstalledRecord): void {
  fs.mkdirSync(serviceWrapperDir(), { recursive: true });
  fs.writeFileSync(installedJsonPath(), JSON.stringify(record, null, 2), "utf8");
}

export function removeInstalledRecord(): void {
  const file = installedJsonPath();
  if (!fs.existsSync(file)) return;
  fs.rmSync(file, { force: true });
}
