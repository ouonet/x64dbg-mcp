import type { ServiceCliOptions } from "./router.js";
export async function runLifecycle(_cmd: "start" | "stop" | "restart", _options: ServiceCliOptions): Promise<number> {
  process.stderr.write("lifecycle not implemented\n");
  return 1;
}
