import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTuiStateRoot } from "./state-root.ts";

test("native TUI state root honors explicit override, XDG state home, and fallback", () => {
  assert.equal(nativeTuiStateRoot({ PI_TUI_WORKER_STATE_ROOT: "/custom/native", XDG_STATE_HOME: "/xdg/state" }, "/home/user"), "/custom/native");
  assert.equal(nativeTuiStateRoot({ XDG_STATE_HOME: "/xdg/state" }, "/home/user"), "/xdg/state/pi-tui");
  assert.equal(nativeTuiStateRoot({}, "/home/user"), "/home/user/.local/state/pi-tui");
  assert.equal(nativeTuiStateRoot({ XDG_STATE_HOME: "" }, "/home/user"), "/home/user/.local/state/pi-tui");
});
