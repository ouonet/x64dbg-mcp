import type { ServiceCliOptions } from "./router.js";
export async function runInstall(_options: ServiceCliOptions): Promise<number> {
  process.stderr.write("install not implemented\n");
  return 1;
}
