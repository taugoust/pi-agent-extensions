import { join } from "node:path";

export function nativeTuiStateRoot(env: NodeJS.ProcessEnv, home: string): string {
  return env.PI_TUI_WORKER_STATE_ROOT ?? join(env.XDG_STATE_HOME || join(home, ".local", "state"), "pi-tui");
}
