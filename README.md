## Overview

**pi-agent-extensions** is a collection of
[pi](https://github.com/mariozechner/pi) coding agent extensions that
enhance the development experience. Each extension is a standalone
TypeScript file that plugs into pi\'s extension system.These extensions
are configured for global auto-discovery and loaded on every pi session.

By default, pi\'s extension system enables all the extensions. Using
`pi config` command, extensions can be disabled per user.

## Installation

Choose one of the following methods:

<details>
<summary><b>Method 1: Install via pi Package Manager</b></summary>
<br>

``` bash
pi install git:github/rytswd/pi-agent-extensions
```

This command:

1.  Clones the repository to `~/.pi/agent/git/`{.verbatim}
2.  Runs `npm install`{.verbatim} to install dependencies
3.  Adds the package path to `~/.pi/agent/settings.json`{.verbatim}
    (`"packages"`{.verbatim} stanza)
4.  Makes all extensions available to pi automatically

</details>
<details>
<summary><b>Method 2: Manual Installation via Git Clone</b></summary>
<br>

1.  Clone the repository to any directory:

``` bash
git clone https://github.com/rytswd/pi-agent-extensions.git ~/path/to/pi-agent-extensions
```

1.  Install dependencies:

``` bash
cd ~/path/to/pi-agent-extensions
bun install
# or: pnpm install
```

This uses workspaces to install extension-specific dependencies (e.g.,
`@mozilla/readability`{.verbatim} and `jsdom`{.verbatim} for the
`fetch`{.verbatim} extension). Extensions gracefully degrade if their
dependencies are not installed --- for example, fetch falls back to
simple regex-based HTML stripping when Readability is unavailable.

1.  Add the package to pi\'s configuration by editing
    `~/.pi/agent/settings.json`{.verbatim}:

``` json
{
  "packages": [
    "/absolute/path/to/pi-agent-extensions"
  ]
}
```

This setup enables all of the extensions.

</details>
<details>
<summary><b>Method 3: Copy Individual Extensions</b></summary>
<br>

For selective installation, copy specific extension directories to
`~/.pi/agent/extensions/`{.verbatim}:

``` bash
# Copy only the extensions you want
cp -r /path/to/pi-agent-extensions/slow-mode ~/.pi/agent/extensions/
cp -r /path/to/pi-agent-extensions/questionnaire ~/.pi/agent/extensions/
```

Or clone directly to the extensions directory:

``` bash
git clone https://github.com/rytswd/pi-agent-extensions.git ~/.pi/agent/extensions/pi-agent-extensions
```

**Note:** If an extension has dependencies (e.g., `slow-mode`{.verbatim}
requires the `diff`{.verbatim} package), you\'ll need to install them:

``` bash
cd ~/.pi/agent/extensions/slow-mode
bun install
```

Extensions are auto-discovered from `~/.pi/agent/extensions/`{.verbatim}
--- pi loads all `*.ts`{.verbatim} files and `index.ts`{.verbatim} files
in subdirectories.

</details>

## ✨ Extensions

<details>
<summary><strong>direnv</strong> - Refresh environment from <code>.envrc</code></summary>
<br>

- **Source**:
  [direnv/](https://github.com/rytswd/pi-agent-extensions/tree/main/direnv)
- **License**: MIT
- **Status bar**: `direnv …` / `direnv ✓` / `direnv ✗`
- **Dependencies**: `direnv` binary in `PATH`

**Description**: Refreshes direnv on session start and after each `bash` tool
call. In ordinary/`pi-unsafe` sessions it preserves the shell-hook behaviour of
running `direnv export json` locally and updating the Pi process environment. In
supervised sessions (`PI_SUPERVISED=1`) it requires the sandbox extension and
uses AgentSH's exact-session `refresh_direnv` endpoint instead: `.envrc` code
runs in the supervised execution workspace, values remain server-side for later
commands, and the trusted parent Pi environment is never mutated. There is no
local fallback when AgentSH is unavailable. Supervised use therefore requires
an AgentSH release that implements `refresh_direnv`; older supervisors fail
closed with an actionable diagnostic.

</details>
<details>
<summary><strong>slow-mode</strong> - Review gate for <code>write</code> and <code>edit</code> tool calls</summary>
<br>

- **Source**:
  [slow-mode/](https://github.com/rytswd/pi-agent-extensions/tree/main/slow-mode)
- **License**: MIT
- **Toggle**: `/slow-mode`{.verbatim}
- **Status bar**: `slow ■`{.verbatim} (when active)
- **Dependencies**: `diff`{.verbatim} package (auto-installed via
  `bun install`{.verbatim})
- **Optional**: `delta`{.verbatim}, `nvim`{.verbatim}, or
  `vim`{.verbatim} for external diff viewing

**Description**: Intercepts `write`{.verbatim} and `edit`{.verbatim}
tool calls, letting you review and approve/reject changes before they
hit disk.

**Features**:

- External diff viewer by default for edits (delta/vim/diff)
- Proper unified diff using Myers algorithm
- Vim-style navigation in inline TUI (`j/k`{.verbatim},
  `u/d`{.verbatim}, `gg/G`{.verbatim})
- `Ctrl+O`{.verbatim} from inline view opens external diff viewer

**Key bindings**:

  Key                                  Action
  ------------------------------------ ------------------------------
  `Enter`{.verbatim}                   Approve changes
  `Esc`{.verbatim}                     Reject changes
  `Ctrl+O`{.verbatim}                  Open in external diff viewer
  `j/k`{.verbatim} / `↑↓`{.verbatim}   Scroll line by line
  `u/d`{.verbatim}                     Scroll half page
  `gg`{.verbatim} / `G`{.verbatim}     Jump to top/bottom

**What it looks like**:

For edits, opens delta/vim diff viewer by default:

``` example
# Delta opens in your terminal showing side-by-side diff
# After you close delta, you get a confirmation prompt:

Apply changes to air/slow-mode.org?
  > Yes
    No
```

For writes (or if no external viewer), shows inline TUI diff:

``` example
────────────────────────────────────────────────────────────────
 EDIT (diff)
 slow-mode.ts

 @@ -28,7 +28,9 @@
  export default function slowMode(pi: ExtensionAPI) {
 +  // State: whether slow mode is currently enabled
    let enabled = false;
 +
 +  // Staging directory for review
    const tmpDir = `/tmp/pi-slow-mode-${process.pid}`;

 (lines 1–30 of 150 — j/k u/d gg/G scroll)

 Enter approve • Esc reject • Ctrl+O external • j/k u/d gg/G scroll
────────────────────────────────────────────────────────────────
```

</details>
<details>
<summary><strong>fence</strong> - Block <code>write</code> and <code>edit</code> outside the working directory</summary>
<br>

- **Source**:
  [fence/](https://github.com/rytswd/pi-agent-extensions/tree/main/fence)
- **License**: MIT
- **Toggle**: `/fence`{.verbatim}
- **Status bar**: `fence ■`{.verbatim} (when active)
- **Dependencies**: none

**Description**: Intercepts `write`{.verbatim} and `edit`{.verbatim}
tool calls that target a path outside the current working directory and
prompts the user to allow or block them. This is a local Pi guardrail;
it is separate from the `sandbox`{.verbatim} AgentSH supervisor-client mode,
where AgentSH owns enforcement and approval state.

**How it works**:

- Resolves the target path (absolute or relative) against
  `ctx.cwd`{.verbatim}
- Normalises both paths to prevent `..`{.verbatim} traversal
- Prompts for confirmation when a path is outside `cwd`{.verbatim}
- Hard-blocks in headless mode (no UI available)
- No-op for all other tool calls (e.g., bash)

**What it looks like** when a write outside cwd is intercepted:

``` example
⚠️  Write outside working directory:

  /home/user/nix-config/home/programs/pi/default.nix

  (cwd: /home/user/pi-agent-extensions)

Allow?
  > Yes
    No
```

</details>
<details>
<summary><strong>modal-editor</strong> - Vim-style modal input editor</summary>
<br>

- **Source**:
  [modal-editor/](https://github.com/rytswd/pi-agent-extensions/tree/main/modal-editor)
- **License**: MIT
- **Origin**: Based on
  [badlogic/pi-mono](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/modal-editor.ts)

**Description**: Replaces the default pi input editor with a vim-style
modal editor. Adds an `INSERT`{.verbatim} / `NORMAL`{.verbatim} mode
indicator to the bottom border of the editor.

**Modes and key bindings**:

  Key                   From     Action
  --------------------- -------- ------------------------------
  `Escape`{.verbatim}   insert   Switch to normal mode
  `i`{.verbatim}        normal   Switch to insert mode
  `a`{.verbatim}        normal   Append (insert + move right)
  `h`{.verbatim}        normal   Move left
  `j`{.verbatim}        normal   Move down
  `k`{.verbatim}        normal   Move up
  `l`{.verbatim}        normal   Move right
  `0`{.verbatim}        normal   Jump to line start
  `$`{.verbatim}        normal   Jump to line end
  `x`{.verbatim}        normal   Delete character
  `Escape`{.verbatim}   normal   Abort agent (default pi)

**What it looks like**:

``` example
────────────────────────────────────────────────────────────────
> hello world█

                                                       NORMAL
────────────────────────────────────────────────────────────────
```

</details>
<details>
<summary><strong>questionnaire</strong> - Interactive multi-question tool with tab navigation</summary>
<br>

- **Source**:
  [questionnaire/](https://github.com/rytswd/pi-agent-extensions/tree/main/questionnaire)
- **License**: MIT
- **Type**: Tool (LLM-callable)
- **Use cases**: Configuration wizards, disambiguation, confirmations,
  multi-step workflows

**Description**: A tool the LLM can call to ask single or
multiple-choice questions with tab-based navigation.

**Features**:

- Single question mode with option list
- Multi-question mode with tab bar and completion indicators (■/□)
- Free-text input option
- Submit review screen showing all answers
- Custom rendering in chat history

**Key bindings**:

  Key                                  Action
  ------------------------------------ -----------------------
  `Tab`{.verbatim} / `←→`{.verbatim}   Navigate between tabs
  `↑↓`{.verbatim}                      Navigate options
  `Enter`{.verbatim}                   Confirm selection
  `Esc`{.verbatim}                     Cancel

**What it looks like**:

Multi-question flow:

``` example
────────────────────────────────────────────────────────────────
← □ Framework  □ TypeScript  □ Styling  ✓ Submit →

Which framework would you like to use?

> 1. React
     Component-based library
  2. Vue
     Progressive framework
  3. Svelte
     Compiled framework
  4. Type something.

Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel
────────────────────────────────────────────────────────────────
```

After selecting \"React\" and pressing Enter:

``` example
────────────────────────────────────────────────────────────────
← ■ Framework  □ TypeScript  □ Styling  ✓ Submit →

Do you want to use TypeScript?

> 1. Yes
  2. No

Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel
────────────────────────────────────────────────────────────────
```

Final submit screen shows all answers:

``` example
────────────────────────────────────────────────────────────────
← ■ Framework  ■ TypeScript  ■ Styling  ✓ Submit →

Ready to submit

Framework: 1. React
TypeScript: 1. Yes
Styling: 1. Tailwind CSS

Press Enter to submit

Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel
────────────────────────────────────────────────────────────────
```

</details>
<details>
<summary><strong>fetch</strong> - HTTP request tool without bash/curl</summary>
<br>

- **Source**:
  [fetch/](https://github.com/rytswd/pi-agent-extensions/tree/main/fetch)

- **License**: MIT

- **Type**: Tool (LLM-callable)

- **Use cases**: Fetching web pages, calling APIs, downloading files

- **Optional dependencies**: `@mozilla/readability`{.verbatim},
  `jsdom`{.verbatim} (for Readability mode --- installed via
  `bun install`{.verbatim} at root)

**Description**: Registers a native `fetch`{.verbatim} tool that the LLM
can use for HTTP requests without relying on `bash`{.verbatim} or
`curl`{.verbatim}. Uses Node.js built-in `fetch`{.verbatim}. Optionally
uses Mozilla Readability for intelligent content extraction from HTML
pages. Without dependencies, falls back to regex-based HTML stripping.

**Features**:

- `GET`{.verbatim}, `POST`{.verbatim}, `PUT`{.verbatim},
  `PATCH`{.verbatim}, `DELETE`{.verbatim}, `HEAD`{.verbatim} methods
- Custom request headers and body
- Configurable timeout (default 30s) and response truncation (default
  100KB)
- Binary download to file via `outputPath`{.verbatim} parameter
- `outputPath`{.verbatim} restricted to `/tmp/`{.verbatim} when
  `write`{.verbatim} tool is not enabled
- Curl equivalent shown on expand (`Ctrl+O`{.verbatim})
- Red error strip for HTTP 4xx/5xx, timeouts, and blocked writes

**Rendering**:

Tool call display:

``` example
fetch GET https://api.example.com/data
fetch POST https://api.example.com/submit
fetch GET https://example.com/logo.png → /tmp/logo.png
```

Collapsed result:

``` example
200 OK · 12.3KB
200 OK · 47.1KB → /tmp/logo.png
```

Expanded result (`Ctrl+O`{.verbatim}) shows curl equivalent:

``` example
$ curl -X POST \
    -H 'Content-Type: application/json' \
    -d '{"query":"test"}' \
    'https://api.example.com/search'
```

Errors show with red background:

``` example
✗ 404 Not Found: https://example.com/missing
✗ Timed out after 30000ms: https://slow.example.com
✗ outputPath restricted to /tmp/ when write tool is not enabled.
```

</details>
<details>
<summary><strong>pdf</strong> - Local or AgentSH-supervised PDF inspection beyond text extraction</summary>
<br>

- **Source**:
  [pdf/](https://github.com/rytswd/pi-agent-extensions/tree/main/pdf)
- **License**: MIT
- **Type**: Tools (LLM-callable)
- **Dependencies**: Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`,
  `pdfimages`) and ImageMagick (`magick`)

**Description**: Registers PDF inspection tools that complement plain
`pdftotext` workflows. In ordinary unsupervised Pi sessions they use the local
filesystem and process runtime. When the `sandbox` extension has an active
AgentSH supervisor, every command, read, and sidecar write is routed through
that supervisor, including forwarded `pi-auto --ssh` sessions; remote paths
remain supervisor-visible `/workspace` paths. The tools can inspect metadata,
render pages to PNG images, crop rendered regions, extract text in multiple
modes, and extract embedded bitmap images. Outputs are written only to
explicitly requested paths or directories and generated image/text artifacts
get JSON metadata sidecars.

**Nix usage**:

``` bash
nix shell nixpkgs#poppler_utils nixpkgs#imagemagick
```

The Home Manager module installs these packages automatically when
`programs.pi.extensions.pdf.enable = true;` is set. Supervised sessions also
require the packages on the AgentSH host; installing them only for a remote
trusted Pi control plane is insufficient.

**Tools**:

- `pdf_info`{.verbatim}: document metadata and page count
- `pdf_render_pages`{.verbatim}: render selected pages like `1,3-5` to PNG
- `pdf_crop_image`{.verbatim}: crop a pixel rectangle from a rendered page
- `pdf_extract_text`{.verbatim}: plain, layout, raw, bbox, or bbox-layout text
- `pdf_extract_images`{.verbatim}: extract embedded raster images

</details>
<details>
<summary><strong>subagent</strong> - Same-session dynamic child Pi processes</summary>
<br>

- **Source**:
  [subagent/](https://github.com/rytswd/pi-agent-extensions/tree/main/subagent)
- **License**: MIT
- **Type**: Tool (LLM-callable)
- **Security model**: Child Pi processes are ordinary descendants of the
  parent Pi process. Under AgentSH they inherit the same session, sandbox,
  approvals, network/file policy, and shadow workspace. The extension does
  **not** spawn `pi-auto`, `pi-supervised`, `agentsh wrap`, or nested AgentSH
  sessions.

**Description**: Registers a `subagent` tool for delegating focused work to
raw child Pi processes in JSON print mode. Subagents are dynamic per call: the
parent supplies the task plus optional `systemPrompt`, `model`, `tools`, and
`cwd`. Child Pi state is isolated under `$PI_CODING_AGENT_DIR/subagents/...` and
only minimal config/auth files are copied.

**Modes**:

``` json
{ "task": "Review README.md", "tools": ["read"] }
{ "tasks": [{ "task": "Find model code", "tools": ["read", "grep", "find"] }] }
{ "chain": [{ "task": "Find files" }, { "task": "Plan from: {previous}" }] }
```

Set `PI_SUBAGENT_BIN` to the raw Pi executable selected by your wrapper, e.g.
`/nix/store/.../bin/pi` or `pi-unsafe`. If unset, the extension tries source/dev
execution, then `pi-unsafe`, and only falls back to `pi` with a warning. Native
children are marked with `PI_SUBAGENT_ID` so child-only extensions can identify
them reliably.

</details>
<details>
<summary><strong>subagent-finalizer</strong> - Finish child tasks before context compaction</summary>
<br>

- **Source**:
  [subagent-finalizer/](https://github.com/rytswd/pi-agent-extensions/tree/main/subagent-finalizer)
- **License**: MIT
- **Activation**: Only child Pi processes marked by `AGENTSH_SUBAGENT_ID` or
  `PI_SUBAGENT_ID`; top-level sessions remain inert.

**Description**: After a continuing subagent turn (`toolUse` or `length`), this
extension checks Pi's current context usage. Once usage exceeds 90%, it sends one
urgent steering message telling the child to stop using tools and return its best
answer to the original task immediately. Steering is delivered before the next
model call, giving the child a final response turn before threshold compaction can
discard detailed task context.

The Home Manager module installs this guard automatically when
`programs.pi.extensions.subagent.enable` is enabled. It can also be enabled on
its own with `programs.pi.extensions.subagent-finalizer.enable`.

</details>
<details>
<summary><strong>sandbox</strong> - AgentSH supervisor client, approval UI, and AgentSH-backed tools</summary>
<br>

- **Source**:
  [sandbox/](https://github.com/taugoust/pi-agent-extensions/tree/main/sandbox)
- **License**: MIT
- **Type**: AgentSH supervisor client (mock NDJSON test protocol and real Stage 1 REST)
- **Commands**: `/sandbox`{.verbatim} for status/debug;
  `/sandbox-control reconnect|recover|start|stop|status`{.verbatim};
  `/sandbox-allow <target>`{.verbatim} for retry guidance
- **Tool overrides**: only registered when an AgentSH integration env var is set.
  Mock NDJSON can handle `bash`{.verbatim}, `write`{.verbatim},
  `edit`{.verbatim}, `subagent`{.verbatim}, and optional `read`{.verbatim};
  real AgentSH REST handles `bash`{.verbatim}, `write`{.verbatim},
  `edit`{.verbatim}, optional supervised `read`{.verbatim}, and
  `subagent`{.verbatim} through `/api/v1/sessions/{id}/tools/*` endpoints when
  the AgentSH supervisor has a generic subagent runtime configured.
- **Status bar**: `agentsh inactive`{.verbatim}, `agentsh start…`{.verbatim},
  `agentsh …`{.verbatim}, `agentsh ✓`{.verbatim}, `agentsh net ✓`{.verbatim},
  `agentsh net ?`{.verbatim}, `agentsh ? N`{.verbatim}, or `agentsh ✗`{.verbatim}
- **Mock helper/check**: `sandbox/mock-supervisor.mjs`{.verbatim} and
  `sandbox/mock-supervisor-check.mjs`{.verbatim}
- **Security model**: in real AgentSH REST mode, AgentSH owns session state,
  approvals, and tool side effects over a local Unix socket. Commands use the
  supervisor exec path; file tools are workspace-confined and policy checked.
  The only outside-workspace read exception is an exact, session-owned output
  artifact capability returned by AgentSH itself.

**Description**: The old passive `AGENTSH_APPROVAL_UI_SOCKET` relay has
been retired. `sandbox` now has two explicit protocol modes:

1. **Mock NDJSON** when `PI_AGENTSH_MOCK_SUPERVISOR` is set. This is the
   planned/Stage 2 protocol used by `sandbox/mock-supervisor.mjs`.
2. **Real Stage 1 REST** when `AGENTSH_SESSION_SUPERVISOR` is set or
   `PI_AGENTSH_ENABLE=1`. This uses HTTP JSON over the AgentSH Unix socket.

With no supervisor/enable env var, the extension stays inactive and does not
register `bash`/`write`/`edit`/`subagent` overrides, so normal Pi tools are not
broken. On `session_start`, it attaches to the mock socket first if present;
otherwise it attaches to the real REST socket, or starts one with
`agentsh session start --detach --policy <policy> --workspace <cwd> --workspace-mode <mode> --json`.

**Environment**:

``` sh
PI_AGENTSH_MOCK_SUPERVISOR=/path/to/mock.sock         # mock NDJSON mode
AGENTSH_SESSION_SUPERVISOR=unix:///path/to/supervisor.sock # real Stage 1 REST mode
AGENTSH_SESSION_ID=session-...                         # recommended with real attach
PI_AGENTSH_ENABLE=1                                    # start detached REST supervisor if no socket env
PI_AGENTSH_POLICY=pi-autonomous|pi-supervised          # default: pi-autonomous
PI_AGENTSH_WORKSPACE_MODE=shadow|direct                # Stage 1 only; default: shadow
PI_AGENTSH_BIN=agentsh                                 # default: agentsh
PI_AGENTSH_READ_MODE=supervised                        # optional read override (mock and real REST)
PI_AGENTSH_APPROVAL_CLIENT=central                     # opt into central detached approval bridge
PI_AGENTSH_REQUIRE_NETWORK_ENFORCEMENT=strict           # refuse tools without live strict runtime evidence
PI_AGENTSH_RECOVERY_COMMAND=/nix/store/.../bin/recover  # optional immutable wrapper-owned recovery executable
PI_AGENTSH_LIFECYCLE_STATE=/private/.../state.json      # optional private canonical wrapper-owned state
PI_AGENTSH_RECOVERY_TIMEOUT_MS=300000                   # bounded explicit recovery request
PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS=600000               # generic non-command REST tool request cap (default: 10m)
PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS=300000             # legacy command-slack default / direnv approval allowance
PI_AGENTSH_CONNECT_TIMEOUT_MS=10000                     # connect timeout and modern terminal/cleanup margin
PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS=14400000        # compatibility default/ceiling when metadata is absent (4h)
PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS=310000             # command response slack baseline; modern server metadata may raise it

PI_AGENTSH_SUBAGENT_EXECUTION_TIMEOUT_MS=7200000       # default/maximum AgentSH child deadline (2h)
PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS=300000          # NDJSON deadline slack after child execution (5m)
PI_AGENTSH_SUBAGENT_TRANSPORT_TIMEOUT_MS=7500000       # optional transport floor; never shortens execution + slack
```

**Mock NDJSON protocol**: newline-delimited JSON over a Unix socket. Requests
have `id`, `op`, and `params`; final responses are
`{"id":"...","ok":true,"result":...}` or `{"id":"...","ok":false,"error":"..."}`.
Streaming ops may emit `stdout`, `stderr`, `tool_update`, `subagent_update`, or
`message` events before the final response. The mock/planned operations are
`hello`, `exec_bash`, `read_file`, `write_file`, `edit_file`,
`spawn_subagent`, `watch_approvals`, `resolve_approval`, and optional `stop`.

**Real AgentSH REST protocol**: HTTP JSON over the Unix socket
(`unix:///absolute/path/to/supervisor.sock`). The extension currently uses:

- `GET /api/v1/sessions` and `GET /api/v1/sessions/{id}` to discover metadata
  when possible;
- `GET /api/v1/sessions/{id}/network-enforcement` for live runtime evidence;
- `GET /api/v1/approvals` on a polling interval to find pending approvals;
- `POST /api/v1/approvals/{id}` to approve/deny with `scope` and `reason`;
  central detached-session approval resolution is used only when explicitly
  requested with `PI_AGENTSH_APPROVAL_CLIENT=central`;
- `POST /api/v1/sessions/{id}/tools/exec_bash` for `bash`{.verbatim};
- `POST /api/v1/sessions/{id}/tools/refresh_direnv` for a value-free,
  server-owned supervised direnv environment refresh;
- `POST /api/v1/sessions/{id}/tools/read_file` for optional supervised
  `read`{.verbatim};
- `POST /api/v1/sessions/{id}/tools/write_file` for `write`{.verbatim};
- `POST /api/v1/sessions/{id}/tools/edit_file` for `edit`{.verbatim};
- `POST /api/v1/sessions/{id}/tools/spawn_subagent` for `subagent`{.verbatim};
- `DELETE /api/v1/sessions/{id}` best-effort for `/sandbox-control stop`.

The REST `exec_bash` response is buffered; it does not stream command output
while the command runs. Ordinary Bash execution and HTTP transport use separate
budgets. On REST hello and every verified reconnect, the extension reads live
session metadata
`command_timeout: { default_ms, maximum_ms?, approval_extension_ms?, source }`,
where AgentSH reports metadata source `policy` or `fallback`.
`approval_extension_ms`, when present, is a non-negative safe integer number of
milliseconds within the AgentSH/Go `time.Duration` range. It is the
server-enforced maximum cumulative approval-wait extension for one ordinary
command—one bounded allowance for the
command, not a new allowance per approval. Valid live metadata is
authoritative. Execution-budget compatibility applies only when an older
supervisor omits the entire `command_timeout` field: the client then uses the
trusted-wrapper value `PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS`, or the built-in
four-hour default, as both its default and client-side ceiling. A present but
malformed `command_timeout` field—including an invalid
`approval_extension_ms`—fails as a protocol/config error instead of silently
falling back. The environment fallback is captured when the trusted extension
loads; values from supervised direnv stay server-side and are never a
command-timeout source. The selected AgentSH policy metadata—not an unrelated
top-level server sample setting or project environment—is the operative source
when available.

When Bash omits `timeout`, the extension derives its client execution budget
from that metadata/default but leaves `timeout_ms` out of the request so AgentSH
can report command source `policy_default` or `fallback`. A positive explicit
timeout is converted to exact integer milliseconds and sent unchanged, up to
AgentSH/Go's `time.Duration` wire maximum of 9,223,372,036,854ms. If live
metadata contains `maximum_ms`, or compatibility mode supplies its mirrored
ceiling, only the client lifetime is based on `min(request, maximum)`;
preserving an above-cap original request lets AgentSH report `policy_cap`.
Transport stays open for the derived execution budget plus the selected actual
command slack. If live metadata includes `approval_extension_ms`, actual slack
is at least that one server allowance plus `PI_AGENTSH_CONNECT_TIMEOUT_MS` as a
bounded terminal/cleanup response margin:
`max(PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS, approval_extension_ms +
PI_AGENTSH_CONNECT_TIMEOUT_MS)`. Thus a shorter configured command slack cannot
expire while AgentSH is still within its advertised approval allowance or the
fixed response margin. If the producer field is absent (including older live
`command_timeout` metadata), the configured command slack is used unchanged.
For supervisors that omit all command-timeout metadata, compatibility likewise
uses that configured slack; its default already contains the legacy approval
allowance plus the connect margin. The execution-plus-slack sum must fit
JavaScript safe-integer arithmetic and the Node.js timer limit. A safe
pre-dispatch socket failure uses the separate supervisor reconnect lifetime;
after verified reconnect the client re-reads metadata, rebuilds the body, and
starts a full command transport lifetime.
Reconnect timeout diagnostics are not command transport timeouts.
`PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS` remains the 600000ms generic budget for
non-command REST tools and is never a Bash default or floor. Thus an explicit
shorter timeout shortens both execution and transport.

A structured AgentSH `E_COMMAND_TIMEOUT` or
`termination_reason=command_timeout` becomes a distinct command execution
timeout with code/exit code 124. Explicit effective fields, including new
AgentSH `command_timeout: { effective_ms, source }`, are retained exactly;
generic `timeout_ms` is not treated as server-effective reporting. If an older
structured response lacks an explicit effective field, the error says the
effective server timeout is unavailable and separately reports the
client-derived execution budget/source. Partial buffered stdout/stderr,
truncation warnings, and any remote output artifact path remain visible in Bash
tool errors. A dispatched socket/response deadline is a distinct command
transport timeout carrying the derived execution/transport budgets and selected
actual slack, while caller abort remains `AbortError`. Exit code 124 alone is
not interpreted as a timeout, because a normal child may return it.

`spawn_subagent` separately uses an NDJSON streaming response for stdout/stderr
and child result events. AgentSH owns the subagent execution deadline. The
extension sends a two-hour `timeout_ms` by default and keeps its NDJSON transport
open for that deadline plus five minutes, so process-tree cleanup and the typed
terminal result can arrive before the client closes. A subagent tool-call
`timeout_ms` can select a shorter execution window but cannot raise the
configured ceiling. `PI_AGENTSH_SUBAGENT_REQUEST_TIMEOUT_MS` remains a
compatibility alias for the default execution timeout; it no longer creates an
independent matching transport deadline. Caller aborts remain distinct from
execution/transport timeouts. Multiple Pi `edit` replacements are applied as
sequential single-replacement REST calls.
When bounded model-facing `bash` output or a completed subagent final overflows,
new AgentSH supervisors retain a capped artifact in the remote session runtime
and return `full_output_path` or `full_result_path`. The extension shows that
path without reading it automatically; supervised `read` can page it on demand.
No supervised overflow file is created in the local parent-Pi temp directory.
Approvals are polled rather than streamed. If `fields.scope_kind`
and `fields.scope_key` are present, Pi offers once/session approve/deny choices.
When the supervisor reports `requested=strict`, the extension refuses all
AgentSH-backed tools unless the live report proves the
`helper-ebpf-proxy-required` tier is ready and `network_policy_enforced=true`.
Additive `helper_lifecycle` evidence is shown separately from supervisor/SSH
transport state, including only non-secret status, lease/unit identity,
soft/hard expiry and remaining time, generations, path liveness, and terminal
reason. Credential and token values are neither expected nor rendered.

Typed AgentSH execution outcomes are normalized from promoted top-level fields,
then nested `exec_response.result` fields, with legacy nested errors retained as
a fallback. Pre-exec/helper failures are reported as “command was not executed”;
queue timeout, cancellation, command timeout, denial, transport ambiguity, and a
genuine child exit 127 remain distinct. Diagnostic messages are bounded and
redacted, and ambiguous mutations are never replayed.

`/sandbox-control start` remains available for local extension-owned sessions,
but is refused when `AGENTSH_SESSION_SUPERVISOR` is provided or
`PI_AGENTSH_REMOTE=ssh`; starting there would leak an unrelated local session.
`/sandbox-control recover` appears only when the wrapper supplies a protected,
versioned lifecycle state file containing the exact expected session ID and an
executable at an immutable `/nix/store` path. The wrapper contract must re-open
and revalidate that stable state path immediately before mutation; the
extension's no-follow/owner/mode/schema checks are defense in depth, not a claim
that pathname TOCTOU is eliminated. Pi invokes the executable directly with no
shell or arguments, a minimal allowlisted environment, an explicit local cwd,
and captured bounded/redacted output. On POSIX it uses a separate process group
and performs bounded TERM/KILL cleanup; group escalation survives direct-child
close and is completed before cancellation, stop, timeout, or shutdown settles.
Recovery and all start/reconnect/stop operations are serialized, shutdown awaits
cleanup, and reattachment publishes no client/watcher state until the exact
captured session ID and fresh proven
strict evidence validate. SSH, sudo, helper credentials, and rebind remain
wrapper-owned, and the failed command is never replayed.

The extension exposes `globalThis.__AGENTSH_PI__` for owned extensions:

- `exec(...)`, `refreshDirenv(...)`, `readFile(...)`, `writeFile(...)`,
  `editFile(...)`, `spawnSubagent(...)`;
- `resolveApproval(...)`;
- `getSupervisorMetadata()` / `getSupervisorState()`.

**Run with only this extension and the mock supervisor**:

``` sh
SOCK=${TMPDIR:-/tmp}/pi-agentsh-mock.sock
nix shell nixpkgs#nodejs --command node sandbox/mock-supervisor.mjs --socket "$SOCK" --fake-approval &
PI_AGENTSH_MOCK_SUPERVISOR="$SOCK" PI_AGENTSH_READ_MODE=supervised \
  pi --no-extensions -e ./sandbox/index.ts
```

(`-e` is short for `--extension`; `--no-extensions` disables normal discovery
so only this extension is loaded.)

**Manual real-AgentSH Stage 1 run**:

``` sh
PI_AGENTSH_ENABLE=1 \
PI_AGENTSH_POLICY=pi-autonomous \
PI_AGENTSH_WORKSPACE_MODE=shadow \
  pi --no-extensions -e ./sandbox/index.ts
```

This starts/attaches a detached REST supervisor and enables AgentSH-backed
`bash`, `write`, `edit`, `subagent`, and optional supervised `read` tool
execution when the supervisor has a generic subagent runtime configured.

Or attach to a supervisor started externally:

``` sh
AGENTSH_SESSION_ID=session-... \
AGENTSH_SESSION_SUPERVISOR=unix:///path/to/sessions/<id>/supervisor.sock \
  pi --no-extensions -e ./sandbox/index.ts
```

**Mock-driven protocol check**:

``` sh
nix shell nixpkgs#nodejs --command node sandbox/mock-supervisor-check.mjs
```

**Current real REST limitations**:

- `subagent` requires `AGENTSH_SUBAGENT_COMMAND` runtime configuration and streams over REST NDJSON rather than the future full supervisor NDJSON protocol;
- command output is buffered, not streamed live;
- file tools are native supervisor filesystem operations, workspace-confined and
  policy checked, but not child-process syscall-supervised writes;
- approval watching is REST polling, not a long-lived socket stream;
- detached supervisors support `shadow` and `direct` workspace modes here;
  `overlay`/`auto` are intentionally not used by this extension for Stage 1.

The guidance tools (`sandbox_allow_path`, `sandbox_allow_read_path`,
`sandbox_allow_domain`, and `sandbox_allow_unix_socket`) remain as explanations
only; they do not grant access or write local policy files.

</details>
<details>
<summary><strong>@marckrenn/pi-sub-core</strong> - Status bar core implementation</summary>
<br>

- **Source**: [pi-sub upstream](https://github.com/marckrenn/pi-sub)
- **License**: MIT
- **Author**: [marckrenn](https://github.com/marckrenn)
- **Type**: Dependency (used by pi-sub-bar)

**Description**: Core implementation for the status bar system,
providing the foundational utilities and APIs for status bar management.

</details>
<details>
<summary><strong>@marckrenn/pi-sub-bar</strong> - Status bar management</summary>
<br>

- **Source**: [pi-sub upstream](https://github.com/marckrenn/pi-sub)
- **License**: MIT
- **Author**: [marckrenn](https://github.com/marckrenn)
- **Dependencies**: `@marckrenn/pi-sub-core`{.verbatim}

**Description**: Status bar extension that provides a persistent bottom
bar for displaying extension status, notifications, and other real-time
information in the pi terminal interface.

</details>

## Skills

<details>
<summary><strong>drawio</strong> - Generate native draw.io diagrams and optional exports</summary>
<br>

- **Source**: [skills/drawio/](./skills/drawio/)
- **License**: Apache-2.0 reference material from official draw.io MCP skill; repository license remains MIT unless otherwise noted
- **Outputs**: `.drawio`, `.drawio.png`, `.drawio.svg`, `.drawio.pdf`, or browser URL
- **Dependencies**: none for `.drawio` files or URL mode; draw.io Desktop CLI for PNG/SVG/PDF export

**Description**: Guides agents to create editable draw.io XML files, open them in draw.io, or export them locally with embedded diagram XML. Intended for durable project figures and paper diagrams rather than broad MCP access.

</details>

<details>
<summary><strong>tikz-figure-recreation</strong> - Recreate paper figures as TikZ</summary>
<br>

- **Source**: [skills/tikz-figure-recreation/](./skills/tikz-figure-recreation/)
- **Outputs**: bare `.tikz` source, standalone preview `.tex`, compiled PDF, optional PNG preview
- **Dependencies**: project LaTeX environment; `tectonic` or equivalent for standalone previews; PDF rendering/cropping tools when inspecting source papers

**Description**: Guides agents through visually recreating existing PDF/image/draw.io paper figures in TikZ. The workflow emphasizes rendering and cropping the reference, creating a standalone TikZ preview harness, compiling and rendering the generated figure, and iterating on visual details such as boundaries, typography, and hand-routed arrows.

</details>

## Configuration

Once installed, pi can use **all** of the extensions listed in this
package\'s `package.json`{.verbatim}. **By default, all extensions are
enabled.**

To manage which extensions are active, run:

``` bash
pi config
```

This opens an interactive TUI where you can:

- View all available extensions from installed packages
- Toggle individual extensions on/off with `Space`{.verbatim}
- Filter extensions by typing
- Navigate with arrow keys

Example:

``` example
────────────────────────────────────────────────────────────────
Resource Configuration                     space toggle · esc close

  ~/Coding/github.com/rytswd/pi-agent-extensions (user)
    Extensions
>     [x] pi-sub-bar/index.ts
      [x] pi-sub-core/index.ts
      [x] fetch/index.ts
      [x] questionnaire/index.ts
      [x] slow-mode/index.ts

────────────────────────────────────────────────────────────────
```

Changes are saved to `~/.pi/agent/settings.json`{.verbatim} and take
effect on the next pi session. The actual content of `settings.json`
would look like below.

``` jsonc
{
  "packages": [
    {
      "source": "~/Coding/github.com/rytswd/pi-agent-extensions",
      "extensions": [
        "-questionnaire/index.ts" # Disabled
      ]
    }
  ]
}
```

## 🚀 Quick Start

After installation, start using pi normally:

``` bash
pi
```

### Try the Extensions

- **slow-mode:** Type `/slow-mode`{.verbatim} to toggle the review gate
- **fetch:** The LLM will use it for HTTP requests --- try asking it to
  fetch a URL
- **pdf:** Ask the LLM to inspect a local or AgentSH-workspace PDF,
  render pages, or crop a page region for visual review
- **drawio:** Ask the LLM to create a diagram or paper figure as a native
  `.drawio` file, optionally exported to PNG/SVG/PDF
- **questionnaire:** The LLM will call it automatically when needed
- **subscription tools:** Use `sub_get_usage`{.verbatim} and
  `sub_get_all_usage`{.verbatim} tools, see status in the bar

## 📁 Structure

``` example
~/.pi/agent/extensions/
├── fence/              # Block write/edit outside cwd
│   └── index.ts
├── fetch/              # HTTP request tool
│   └── index.ts
├── modal-editor/       # Vim-style modal input editor
│   └── index.ts
├── pdf/                # Local or AgentSH-supervised PDF inspection tools
│   ├── backend.ts
│   └── index.ts
├── questionnaire/      # Multi-question tool
│   └── index.ts
├── sandbox/            # AgentSH supervisor client and approval UI
│   ├── index.ts
│   ├── mock-supervisor.mjs
│   └── mock-supervisor-check.mjs
├── subagent/           # Dynamic same-session child Pi processes
│   └── index.ts
├── subagent-finalizer/ # Finish subagents before context compaction
│   └── index.ts
├── slow-mode/          # Review gate for write/edit
│   ├── index.ts
│   ├── package.json    # Dependencies (diff package)
│   ├── package-lock.json
│   ├── bun.lock
│   └── node_modules/   # npm packages (gitignored)
├── skills/             # Pi skills
│   └── drawio/         # Native draw.io diagram generation guidance
├── package.json        # Package metadata and extension list
├── .gitignore          # Ignores node_modules, logs
├── AGENTS.md           # Agent context for AI assistants
└── README.md           # This file
```

## 🔧 Adding New Extensions

To add a new extension, create a directory with an `index.ts`{.verbatim}
file. pi auto-discovers `*.ts`{.verbatim} files and
`index.ts`{.verbatim} files in subdirectories.

A minimal extension looks like:

``` typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

**Recommended structure:**

``` example
my-extension/
├── index.ts           # Extension entrypoint
├── package.json       # Optional: if you need dependencies
└── node_modules/      # Optional: npm packages (gitignored)
```

See the [pi documentation](https://github.com/mariozechner/pi) for the
full extension API.

## 🙏 Acknowledgements

- [Mario Zechner](https://github.com/mariozechner): pi coding agent

## 📄 License

MIT
