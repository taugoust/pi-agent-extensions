import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Explicit raw-Pi test fixture: these launcher tests install no job tool.
 * Real job integration uses the actual background-job extension instead. */
export default function emptyJobsFixture(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    (globalThis as any).__paeLocalJobControllerV1 = {
      protocol: 1, sessionId: ctx.sessionManager.getSessionId(),
      async prepareReap(preserve: (report: unknown) => Promise<void>) {
        await preserve({ jobs: [], fixture: "no job extension installed" });
        return () => {};
      },
    };
  });
}
