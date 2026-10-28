import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Legacy package selection retained for compatibility. Use /accounts instead.
 * Nix selections depend on openai-accounts; this entrypoint registers no command.
 */
export default function openaiUsage(_pi: ExtensionAPI): void {}
