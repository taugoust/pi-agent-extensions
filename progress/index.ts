import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import progress from "./progress-widget.js";
import { reconstructProgress } from "./progress-state.js";
import { registerObservation, displayText } from "../shared/observability.ts";
export default function (pi: ExtensionAPI) {
	progress(pi);
	registerObservation(pi, "progress", (ctx) => ({
		steps: reconstructProgress(ctx.sessionManager.getBranch()).map((step) => ({
			text: displayText(step.text, 512),
			status: step.status,
		})),
	}));
}
