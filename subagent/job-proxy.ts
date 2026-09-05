import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { JobParameters, JOB_REQUEST_TITLE, validateJobParams } from "../shared/background-job.js";

export default function parentOwnedJobs(pi: ExtensionAPI) {
  pi.registerTool({
    name: "background_job", label: "Parent-owned background job",
    description: "Start and observe durable jobs through the parent harness. Jobs remain visible to the parent and survive this child's exit. You may inspect/control only jobs belonging to this task. adopt pane_id links an existing tmux pane as a managed job without restarting it; cancellation closes that pane. pid+log_path adoption remains observation-only. Use this instead of handwritten tmux runners.",
    parameters: JobParameters,
    async execute(toolCallId, params, signal, _update, ctx) {
      if (ctx.mode !== "rpc" || !process.env.PI_SUBAGENT_ID) throw new Error("Parent job broker is available only to native RPC children");
      validateJobParams(params as any);
      if (signal?.aborted) throw new Error("Job request cancelled before dispatch");
      const request = JSON.stringify({ toolCallId, params });
      if (Buffer.byteLength(request) > 48 * 1024) throw new Error("Parent job request is oversized");
      const response = await ctx.ui.input(JOB_REQUEST_TITLE, request, { signal });
      if (!response) throw new Error("Parent job service unavailable or request cancelled; do not relaunch automatically");
      const parsed = JSON.parse(response);
      if (parsed.error) throw new Error(String(parsed.error));
      if (!Array.isArray(parsed.content)) throw new Error("Invalid parent job response");
      return parsed;
    },
  });
}
