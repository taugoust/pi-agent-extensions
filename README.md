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
in subdirectories. When manually copying `background-job`, `direnv`, `fetch`,
`pdf`, `permission-gate`, `sandbox`, `ssh`, or `subagent`, also copy this repository's
`shared/` directory beside the extension directories. Nix bundles and the Home
Manager module add that shared runtime automatically.

</details>

## AgentSH mode selection

AgentSH-aware extensions share one startup classification. Full AgentSH is
selected by a REST/mock supervisor, `PI_AGENTSH_ENABLE=1`, or trusted wrapper
signals such as `PI_SUPERVISED=1`, `PI_AUTO=1`,
`PI_AGENTSH_REMOTE=ssh`, `PI_AGENTSH_READ_MODE=supervised`, and an AgentSH child
capability. Once full mode is selected, adaptive tools fail closed until a full
supervisor is active; they never fall back to native commands, files, network,
direnv, SSH, PDF processing, or subagents.

`AGENTSH_PERMISSION_GATE_SOCKET` remains a distinct **guard-only** startup mode:
it authorizes Bash and native background-start intent but does not claim that
execution is supervised.
The compatibility `AGENTSH_APPROVAL_UI_SOCKET` protocol is likewise
approval-only. Neither limited protocol selects the full backend by itself.
Selecting guard-only and full authority together is a configuration conflict
and Bash fails closed without opening duplicate authorization prompts.
Published supervisor state includes its concrete `protocol`; `active=true`
means a usable client has completed its initial attachment (or is reconnecting
an already attached client), not merely that AgentSH was configured or attempted.

## ✨ Extensions

<details>
<summary><strong>openai-fast-mode</strong> - OpenAI priority inference toggle</summary>
<br>

- **Source**: pinned unchanged from [`pi-openai-fast-mode` 0.3.0](https://github.com/johncmunson/pi-openai-fast-mode/releases/tag/v0.3.0)
- **Command**: `/fast [on|off|toggle]`
- **Default**: loaded but disabled
- **Home Manager**: `programs.pi.extensions.openai-fast-mode.enable = true;`

**Description**: Adds OpenAI Fast Mode priority-inference support. Loading the
extension never enables Fast Mode automatically; use `/fast` or `/fast on` in a
session. The Nix registry exposes it as `openai-fast-mode`, deduplicates bundle
selection, and projects source files individually so its `config.json` remains
writable outside the Nix store.

</details>
<details>
<summary><strong>auto</strong> - Draft controls for <code>pi-auto</code></summary>
<br>

- **Source**: `auto/`
- **Command**: `/auto`
- **Status bar**: `auto · Draft ready` or degraded/action state
- **Dependencies**: the trusted `pi-auto` wrapper and `sandbox` extension

**Description**: Adds a user-only Draft action panel to interactive
`pi-auto` sessions. It can request Review, Apply and exit, Discard and exit, or
Pause and exit. The extension never exposes these actions as model-callable
tools; it writes a private, exact-session handoff and asks Pi to shut down
gracefully. The outer wrapper performs review/finalization only after Pi and its
extensions have stopped.

</details>
<details>
<summary><strong>background-job</strong> - Durable native shell jobs in controlled tmux windows</summary>
<br>

- **Source**: `background-job/`
- **Tool**: `background_job` with `start`, `list`, `status`, `output`, bounded
  `wait`, `signal`, and `cancel`
- **Command**: `/background-jobs`
- **Dependencies**: tmux and Node.js (installed by the Home Manager module)

**Description**: Runs long native commands in an extension-owned tmux server
without overriding Pi's Bash tool. Jobs, private metadata, and a bounded 1 MiB
output tail live under Pi's private agent state directory and survive turns,
compaction, extension reload, session replacement, and Pi exit. Model-facing
operations are bound to the creating Pi session and expose only opaque job IDs;
they cannot provide tmux targets or tmux commands. Output returned to the model
is further limited to 50 KiB/2000 lines. Aggregate concurrency is eight jobs
and per-working-directory concurrency is four. Terminal records older than
seven days, or beyond the newest 100, are pruned when another job starts.

A cancelled `wait` leaves the underlying job running. `cancel` is the only
lifecycle action that stops a job. Deduplicated terminal notifications steer an
active agent to inspect completed or failed work; idle agents receive a durable,
passive event on their next turn. Reading terminal status/output suppresses a
stale notification. After starting work, one bounded settle-time reminder
prevents the agent from silently forgetting jobs that are still running without
creating a reminder loop or waking an otherwise idle session. Starts pass
through the same Permission Gate classification as ordinary Bash. Guard-only
AgentSH can authorize native
starts, while full AgentSH mode fails closed until it has a dedicated
background-job backend. Interactive pane input and tmux coordinates are
intentionally not exposed to the model; users can obtain the fixed private-server
attach command through `/background-jobs`.

</details>
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
sessions classified as full AgentSH (including `PI_SUPERVISED=1`) it requires
the sandbox extension and uses AgentSH's exact-session `refresh_direnv` endpoint
instead: `.envrc` code
runs in the supervised execution workspace, values remain server-side for later
commands, and the trusted parent Pi environment is never mutated. There is no
local fallback when AgentSH is unavailable. Supervised use therefore requires
an AgentSH release that implements `refresh_direnv`; older supervisors fail
closed with an actionable diagnostic.

</details>
<details>
<summary><strong>permission-gate</strong> - AgentSH or legacy dangerous-command authorization</summary>
<br>

- **Source**:
  [permission-gate/](https://github.com/rytswd/pi-agent-extensions/tree/main/permission-gate)
- **License**: MIT
- **Command**: `/permission-gate` toggles only the unsupervised legacy gate;
  AgentSH-owned gates cannot be disabled from Pi
- **Status bar**: `gate ■` in legacy mode, or `AgentSH gate ■` / `?` / `✗`
  with an inherited AgentSH gate

**Description**: Selects exactly one authority for Bash tool calls and
`background_job` starts:

1. When the trusted AgentSH launcher passes `AGENTSH_PERMISSION_GATE_SOCKET`,
   the extension claims and deletes that environment marker, connects to the
   private one-shot Unix rendezvous, performs the version 1 hello, and sends
   every exact Bash command or background start, working directory, and Pi
   tool-call ID to AgentSH.
   AgentSH—not Pi's local regex list—classifies the command and durably audits
   the terminal decision. Allowed background starts receive a one-use receipt
   bound to the exact tool-call ID, command, and working directory, preventing
   post-authorization argument mutation before launch. Trusted Bash routers
   (currently SSH targeting) apply their idempotent rewrite before this exact
   authorization regardless of extension handler order.
2. Full AgentSH supervised, Auto, and sandbox modes suppress this legacy gate
   once the supervisor is active, so they do not produce a duplicate prompt.
   If full mode was selected but its supervisor is unavailable, the extension
   blocks Bash rather than permitting native fallback.
3. Only an ordinary session with neither integration uses the original local
   dangerous-command regex prompts and `/permission-gate` toggle.

The rendezvous protocol is bounded JSONL (64 KiB frames, with smaller command,
cwd, ID, and prompt-preview limits). AgentSH prompt metadata is rendered through
an attached Paseo permission card or Pi's selectable UI, with **Deny first** and
the active cancellation signal. Pi sends `resolve` for explicit allow/deny or
`cancel` for dismissal, timeout, headless use, or abort, then waits for
AgentSH's audited `complete` acknowledgement before allowing anything. Invalid
FDs, handshake/version errors, malformed or oversized frames, mismatched IDs,
unexpected EOF, timeout, and abort all fail closed. The default per-step and
prompt bound is five minutes; a trusted launcher may set
`PI_AGENTSH_PERMISSION_GATE_TIMEOUT_MS` to another positive millisecond value.

This AgentSH mode is a lightweight **guard only**. It authorizes command intent
but does not create a sandbox or observe native Bash execution. Launch it via
AgentSH rather than setting `AGENTSH_PERMISSION_GATE_SOCKET` manually. AgentSH
creates the private mode-0700 rendezvous, binds its peer to the launched Pi PID
on Linux, and removes its path immediately after the one allowed connection.

``` sh
agentsh permission-gate run -- pi
```

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
- Attached Paseo sessions show approval cards containing the proposed write or unified diff. Remote users can approve, reject, or hand the full review back to the terminal; oversized previews cannot be approved remotely.

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
indicator to the bottom border of the editor. Normal-mode yanks use Pi's
OSC 52-capable copy path; `p`{.verbatim} / `P`{.verbatim} and insert-mode
`Ctrl+V`{.verbatim} query the terminal clipboard with OSC 52 when no local
desktop clipboard is available or Pi is running over SSH/mosh. This also works
through nested tmux when every layer uses
`set-clipboard on`{.verbatim} and the outer terminal permits clipboard reads.

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
- **Paseo**: Attached sessions present each question as a sequential choice
  card. Free-text answers can be handed back to the full terminal UI.

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
<summary><strong>fetch</strong> - Adaptive native and AgentSH-supervised HTTP</summary>
<br>

- **Source**:
  [fetch/](https://github.com/rytswd/pi-agent-extensions/tree/main/fetch)

- **License**: MIT

- **Type**: Tool (LLM-callable)

- **Use cases**: Fetching web pages, calling APIs, downloading files

- **Optional dependencies**: `@mozilla/readability`{.verbatim},
  `jsdom`{.verbatim} (for Readability mode --- installed via
  `bun install`{.verbatim} at root)

**Description**: Registers one adaptive `fetch`{.verbatim} tool. Outside
AgentSH it uses bounded Node.js `fetch`{.verbatim}; with an active AgentSH
supervisor it executes bounded `curl` through AgentSH so DNS, destination
policy, approvals, cancellation, and audit remain authoritative. If AgentSH is
expected but unavailable, native fallback is disabled. Supervised runtimes must
provide `curl`. Optional Mozilla Readability support falls back to regex-based
HTML stripping when its dependencies are absent.

**Features**:

- `GET`{.verbatim}, `POST`{.verbatim}, `PUT`{.verbatim},
  `PATCH`{.verbatim}, `DELETE`{.verbatim}, `HEAD`{.verbatim} methods
- Custom request headers and body
- Configurable timeout (default 30s) and response truncation (default
  100KB)
- Bounded, atomically published downloads via `outputPath`{.verbatim}
- Native `outputPath`{.verbatim} is always restricted to the canonical system
  temporary directory; supervised paths are translated and enforced by AgentSH
- HTTP(S)-only initial and redirect protocols
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
Native fetch outputPath is restricted to /tmp/
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
<summary><strong>subagent</strong> - Adaptive native and AgentSH-backed delegation</summary>
<br>

- **Source**:
  [subagent/](https://github.com/rytswd/pi-agent-extensions/tree/main/subagent)
- **License**: MIT
- **Type**: Tool (LLM-callable)
- **Command**: `/background` moves every currently running foreground
  `subagent` invocation to the background without restarting it
- **Security model**: This is the sole model-facing `subagent` registration.
  With an active AgentSH supervisor it delegates through AgentSH, including
  isolated Git-backed Draft VMs. Without AgentSH configuration it starts raw
  child Pi processes. If AgentSH is expected but unavailable, it fails closed
  and never falls back to native execution.

**Description**: Registers one adaptive `subagent` tool. The parent supplies a
single task, parallel tasks, a chain, a background lifecycle operation, or an
AgentSH Draft disposition. Native child Pi state is isolated under
`$PI_CODING_AGENT_DIR/subagents/...`; AgentSH owns policy, streaming, approvals,
artifacts, and Draft lifecycle whenever its backend is active. In guard-only
`pi-unsafe` sessions, each native child loads only immutable Nix-store finalizer
and permission-proxy extensions. The proxy exposes shell execution under the
distinct `parent_bash` child-tool name, so a missing proxy cannot fall back to
Pi's built-in Bash. Every command is relayed from that wrapper through a private
one-connection Unix rendezvous to the launcher's parent-bound AgentSH Permission
Gate, so dangerous commands appear in the parent terminal and Paseo for approval.
Missing, disconnected, cancelled, stale, or conflicting authority blocks the
child command; infrastructure loss terminates the child rather than becoming a
model-visible ordinary denial. A successful child must close its authenticated
relay with `goodbye`. This guarded-native relay currently requires Linux process
identity support. Guarded native children accept only Pi's built-in `read`, `bash`,
`edit`, and `write` tool names; project/package extensions are deliberately not
loaded. This is still intent authorization, not containment: full AgentSH is
required for filesystem, process, network, and descendant enforcement.

**Modes**:

``` json
{ "task": "Review README.md", "tools": ["read"] }
{ "tasks": [{ "task": "Find model code", "tools": ["read", "grep", "find"] }] }
{ "chain": [{ "task": "Find files" }, { "task": "Plan from: {previous}" }] }
{ "task": "Run the slower investigation", "background": true }
{ "operation": "wait", "job_id": "subagent-job-...", "wait_ms": 30000 }
{ "operation": "result", "job_id": "subagent-job-...", "child": 1, "offset": 0, "limit": 49152 }
{ "mode": "draft", "task": "Implement and commit the change in an isolated VM" }
{ "mode": "draft", "action": "review", "draft_id": "session-..." }
```

Background launches support single, parallel, and chain requests through both
adaptive backends. They return immediately, retain a 50 KiB preview plus each
child's complete terminal report up to 16 MiB in a private per-user store, with
a fair 32 MiB aggregate cap per job, and emit deduplicated active/passive completion events. `result` pages those reports
by byte `offset` and a limit of at most 48 KiB (leaving room inside the 50 KiB
parent-response budget); parallel and chain jobs select a one-based `child`.
`list`, `status`, `output`, bounded `wait`, `result`, and `cancel` remain part of
the same tool. Artifact identity and SHA-256 are verified before each page is
returned, and result artifacts are removed with their terminal job record.
Cancelling `wait` does not cancel execution. Because
AgentSH authority and native child pipes are bound to the owning Pi process,
running background subagents are cancelled on orderly session shutdown and are
reported as `lost` after an unclean Pi restart; terminal records remain
available for seven days. Draft cancellation never applies or discards a
retained Draft result.

While foreground subagent calls are blocking the parent, `/background` promotes
all currently running calls in place. A single, parallel, or chain call remains
one aggregate job; multiple sibling `subagent` calls receive separate job IDs.
Foreground rendering stops, the original execution continues under the existing
background manager, and each detached tool result explicitly tells the parent
agent to continue useful work and consume the result before completing dependent
work. The command does nothing to existing background jobs or unrelated tools.
It refuses an all-at-once handoff when the eight-job aggregate background limit
would be exceeded. Escape retains its normal cancellation behavior before a
successful handoff; afterward, only `operation=cancel` cancels the detached work.

Set `PI_SUBAGENT_BIN` to the raw Pi executable selected by your wrapper, e.g.
`/nix/store/.../bin/pi`. If unset, the extension tries source/dev execution,
then `pi-unsafe`, and only falls back to `pi` with a warning. Native children are
marked with `PI_SUBAGENT_ID` so child-only extensions can identify them
reliably. A guard-only parent directly re-executes its current raw Pi binary and
requires both that executable and the child proxy to be immutable Nix-store
files; it ignores wrapper/PATH fallbacks. The explicitly loaded child proxy returns each shell authorization to the
already-bound parent Permission Gate instead of creating an unapprovable nested
guard process.

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
discard detailed task context. AgentSH children also receive one warning before
their authoritative execution deadline. Long runs retain the five-minute lead;
short explicit deadlines warn after three quarters of their available runtime
instead of steering the child immediately at startup.

The Home Manager module and extension bundles install this guard automatically
with `sandbox` or `subagent`; it can also be enabled on its own. Native
subagents explicitly load the packaged finalizer entrypoint because their
isolated `PI_CODING_AGENT_DIR` does not inherit parent extension discovery.

</details>
<details>
<summary><strong>ssh</strong> - Local/SSH target routing with optional AgentSH sandboxing</summary>
<br>

- **Source**: [ssh/](https://github.com/taugoust/pi-agent-extensions/tree/main/ssh)
- **License**: MIT
- **Flag**: `--ssh host[:path]`{.verbatim}
- **Command**: `/retarget [host[:path]]`{.verbatim}

**Description**: Owns execution-target selection for both legacy and supervised
Pi sessions. In `pi-unsafe`, remote read/write/edit/Bash and `!` commands use
raw SSH; `/retarget` changes targets in-process and no argument returns to the
local launch directory. When an AgentSH sandbox is configured, the extension
publishes the selected target to the sandbox API and never falls back to raw
SSH. The trusted `pi-supervised` wrapper replaces the AgentSH lifecycle, then
resumes the same saved conversation. Every supervised retarget gets a fresh
sandbox and may therefore lose previous session-scoped grants.

For `/retarget host` the destination login shell's `pwd` is used. Supply
`host:/path` to select an explicit remote directory. `pi-auto` intentionally
does not expose retargeting because its shadow workspace and review state are
bound to one target.

</details>
<details>
<summary><strong>sandbox</strong> - AgentSH supervisor client, approval UI, and AgentSH-backed tools</summary>
<br>

- **Source**:
  [sandbox/](https://github.com/taugoust/pi-agent-extensions/tree/main/sandbox)
- **License**: MIT
- **Type**: AgentSH supervisor client (mock NDJSON test protocol and real Stage 1 REST)
- **Commands**: `/sandbox`{.verbatim} for status/debug;
  `/sandbox-allow <target>`{.verbatim} for retry guidance
- **Tool overrides**: registered whenever the canonical startup classification
  selects full AgentSH, including trusted wrapper signals without a usable
  transport; the latter remain unavailable and fail closed. Mock NDJSON can
  handle `bash`{.verbatim}, `write`{.verbatim},
  `edit`{.verbatim}, and optional `read`{.verbatim}; real AgentSH REST handles
  those tools through `/api/v1/sessions/{id}/tools/*`. The separate adaptive
  `subagent` extension is the sole registration and consumes the sandbox's
  AgentSH backend when active.
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

With no full-mode signal, the extension stays inactive and does not register
`bash`/`write`/`edit` overrides. The adaptive `subagent` extension uses its
native backend in that case. A full-mode wrapper signal without a full
supervisor transport still registers the overrides, publishes an unavailable
state, and refuses native fallback. On `session_start`, the extension attaches
to the canonically selected mock or real REST socket, or starts one with
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
PI_AGENTSH_APPROVAL_BELL=1                             # ring once when an AgentSH decision prompt opens
PI_AGENTSH_REQUIRE_NETWORK_ENFORCEMENT=strict           # refuse tools without live strict runtime evidence
PI_AGENTSH_RECOVERY_COMMAND=/nix/store/.../bin/recover  # optional immutable wrapper-owned recovery executable
PI_AGENTSH_LIFECYCLE_STATE=/private/.../state.json      # optional private canonical wrapper-owned state
PI_AGENTSH_RECOVERY_TIMEOUT_MS=300000                   # bounded explicit recovery request
PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS=600000               # generic non-command REST tool request cap (default: 10m)
PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS=300000             # legacy command-slack default / direnv approval allowance
PI_AGENTSH_CONNECT_TIMEOUT_MS=10000                     # connect timeout and modern terminal/cleanup margin
PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS=14400000        # compatibility default/ceiling when metadata is absent (4h)
PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS=310000             # command response slack baseline; modern server metadata may raise it

PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT=1                  # opt in to model-visible per-request timeout_ms; hidden by default
PI_AGENTSH_SUBAGENT_EXECUTION_TIMEOUT_MS=7200000       # optional compatibility client ceiling; unset defers to AgentSH policy
PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS=300000          # NDJSON deadline slack after an explicit child timeout (5m)
PI_AGENTSH_SUBAGENT_TRANSPORT_TIMEOUT_MS=7500000       # optional transport floor; never shortens explicit execution + slack
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
- `POST /api/v1/sessions/{id}/tools/spawn_subagent` for `subagent`{.verbatim}.

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
model-facing `subagent` tool hides `timeout_ms` by default so an agent cannot
invent a speculative short deadline for work whose duration it cannot predict.
Operators may set `PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT=1` before Pi starts to
restore that schema field. Trusted programmatic callers retain the underlying
API option regardless of schema visibility. When the call omits `timeout_ms`,
the extension also omits it from the request so the effective session policy can
select the deadline. The transport then remains open under server authority,
bounded only by Node's maximum timer as a final client safety limit. An enabled
explicit `timeout_ms` selects a shorter requested window and gives the transport
that duration plus five minutes for process-tree cleanup and the typed terminal
result. AgentSH still applies the policy ceiling.
`PI_AGENTSH_SUBAGENT_EXECUTION_TIMEOUT_MS` and its legacy
`PI_AGENTSH_SUBAGENT_REQUEST_TIMEOUT_MS` alias remain optional compatibility
client ceilings for older deployments; neither is a built-in execution default.
Caller aborts remain distinct from execution/transport timeouts. Completed
subagents remain successful Pi tool results; failed, cancelled, and timed-out
terminal states are promoted through Pi's `tool_result` event path so the parent
records `isError=true` rather than treating failure text as a successful tool.
AgentSH-owned child Pi processes may receive an internal
`AGENTSH_CHILD_CAPABILITY`. The
extension validates that credential and sends it as
`X-AgentSH-Child-Capability` only on Unix-socket `exec_bash` requests; it is not
included in command environment payloads or unrelated supervisor operations.
AgentSH binds it to the exact child process and uses it for authenticated
per-child execution-lane admission. Multiple Pi `edit` replacements are applied as
sequential single-replacement REST calls.
When bounded model-facing `bash` output or a completed subagent final overflows,
new AgentSH supervisors retain a capped artifact in the remote session runtime
and return `full_output_path` or `full_result_path`. The extension shows that
path without reading it automatically; supervised `read` can page it on demand.
No supervised overflow file is created in the local parent-Pi temp directory.
Approvals are polled rather than streamed. The default prompt is compact and
kind-aware: it shows the requested operation and target, adds only a meaningful
reason or actor attribution, and keeps opaque IDs, timestamps, internal rule
keys, and raw `fields` payloads out of the decision UI. Network prompts promote
useful context such as SSH, HTTPS, or private-address access into the title,
show the destination once, and never display unrendered policy placeholders.
Command prompts promote a concise policy reason into the question, shorten
immutable Nix-store executables to their basename, and suppress a redundant
leading argv entry only in the display. If `fields.scope_kind` and
`fields.scope_key` are present, Pi offers concise once/session choices whose
labels make broader file and command scope explicit. Every approval kind
safe-defaults to `Deny once`, followed by the commonly used allow choices.
Network prompts retain destination/session denial to suppress retries. When
AgentSH advertises a command-lifetime scope, Pi also offers `Allow all requests
for this command invocation`; it covers pending and future approval-required
operations carrying the same top-level command ID, but is neither a session
grant nor an override for hard policy denials. Command prompts retain
exact-invocation/session denial but omit broader executable-wide or
command-wide denial; exact grants precede executable-wide grants. File prompts retain all
scoped allow choices without scoped denials. When a terminal Pi session is attached through
a compatible Paseo bridge, the legacy and AgentSH-owned `permission-gate`
selections and full AgentSH approval selections are rendered as Paseo permission
cards while remaining actionable in the terminal. The first terminal or Paseo
response wins and dismisses the other presentation. Paseo transports only the selected label;
`sandbox` maps it back to the original AgentSH approval ID and exact scope metadata before
asking AgentSH to resolve it. A bridge disconnect or response failure denies the request, while
sessions without an attached bridge retain their normal terminal UI. In native Pi RPC mode,
the extension uses Pi's standard selectable UI rather than the TUI-only custom overlay.
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

Supervisor lifecycle is launcher-owned. The extension attaches or performs its
configured initial local startup on `session_start`; it does not expose runtime
start, stop, reconnect, or recovery commands. When a trusted launcher supplies
a protected lifecycle state and immutable recovery executable, transport
recovery remains automatic, exact-session-bound, bounded, and fail-closed. SSH,
sudo, helper credentials, replacement, and rebind remain wrapper-owned, and an
ambiguous failed command is never replayed.

The extension exposes `globalThis.__AGENTSH_PI__` for owned extensions:

- `exec(...)`, `refreshDirenv(...)`, `readFile(...)`, `writeFile(...)`,
  `editFile(...)`, `spawnSubagent(...)`;
- `resolveApproval(...)`;
- `setExecutionTarget(...)` / `getExecutionTarget()` for the SSH target router;
- `getSupervisorMetadata()` / `getSupervisorState()`; state reports
  `configured`, readiness-correct `active`, and supervisor `protocol` (`rest`,
  `mock-ndjson`, `legacy-approval-ui`, or empty).

**Run with only the sandbox backend, adaptive subagent, and mock supervisor**:

``` sh
SOCK=${TMPDIR:-/tmp}/pi-agentsh-mock.sock
nix shell nixpkgs#nodejs --command node sandbox/mock-supervisor.mjs --socket "$SOCK" --fake-approval &
PI_AGENTSH_MOCK_SUPERVISOR="$SOCK" PI_AGENTSH_READ_MODE=supervised \
  pi --no-extensions -e ./sandbox/index.ts -e ./subagent/index.ts
```

(`-e` is short for `--extension`; `--no-extensions` disables normal discovery.
The sandbox publishes the backend and the adaptive extension registers the sole
`subagent` tool.)

**Manual real-AgentSH Stage 1 run**:

``` sh
PI_AGENTSH_ENABLE=1 \
PI_AGENTSH_POLICY=pi-autonomous \
PI_AGENTSH_WORKSPACE_MODE=shadow \
  pi --no-extensions -e ./sandbox/index.ts -e ./subagent/index.ts
```

This starts/attaches a detached REST supervisor and enables AgentSH-backed
`bash`, `write`, `edit`, `subagent`, and optional supervised `read` tool
execution when the supervisor has a generic subagent runtime configured.

Or attach to a supervisor started externally:

``` sh
AGENTSH_SESSION_ID=session-... \
AGENTSH_SESSION_SUPERVISOR=unix:///path/to/sessions/<id>/supervisor.sock \
  pi --no-extensions -e ./sandbox/index.ts -e ./subagent/index.ts
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
├── permission-gate/    # AgentSH/legacy Bash authorization gate
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
