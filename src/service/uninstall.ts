import type { ServiceCliOptions } from "./router.js";
export async function runUninstall(_options: ServiceCliOptions): Promise<number> {
  process.stderr.write("uninstall not implemented\n");
  return 1;
}
