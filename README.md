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

**Description**: Runs `direnv export json` on session start and after each
`bash` tool call, then applies environment variable updates to the running
agent process.

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
it is separate from the `sandbox`{.verbatim} AgentSH approval relay,
where AgentSH owns enforcement.

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
<summary><strong>pdf</strong> - Local PDF inspection beyond text extraction</summary>
<br>

- **Source**:
  [pdf/](https://github.com/rytswd/pi-agent-extensions/tree/main/pdf)
- **License**: MIT
- **Type**: Tools (LLM-callable)
- **Dependencies**: Poppler (`pdfinfo`, `pdftoppm`, `pdftotext`,
  `pdfimages`) and ImageMagick (`magick`)

**Description**: Registers local-only PDF inspection tools that complement
plain `pdftotext` workflows. The tools can inspect metadata, render pages to
PNG images, crop rendered regions, extract text in multiple modes, and extract
embedded bitmap images. Outputs are written only to explicitly requested paths
or directories and generated image/text artifacts get JSON metadata sidecars.

**Nix usage**:

``` bash
nix shell nixpkgs#poppler_utils nixpkgs#imagemagick
```

The Home Manager module installs these packages automatically when
`programs.pi.extensions.pdf.enable = true;` is set.

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
execution, then `pi-unsafe`, and only falls back to `pi` with a warning.

</details>
<details>
<summary><strong>sandbox</strong> - AgentSH approval relay UI</summary>
<br>

- **Source**:
  [sandbox/](https://github.com/rytswd/pi-agent-extensions/tree/main/sandbox)
- **License**: MIT
- **Type**: Extension and LLM-callable guidance tools
- **Commands**: `/sandbox`{.verbatim} to show relay status;
  `/sandbox-control`{.verbatim} to explain that enforcement is controlled
  by AgentSH; `/sandbox-allow <target>`{.verbatim} to print retry guidance
- **Status bar**: `agentsh inactive`{.verbatim}, `agentsh ✓`{.verbatim},
  `agentsh ? N`{.verbatim}, or `agentsh ✗`{.verbatim}
- **Dependencies**: Node.js built-in networking, Pi extension APIs, and
  `@sinclair/typebox`{.verbatim}; no sandbox runtime package
- **Security model**: AgentSH owns enforcement, approval state, scoped
  approval caching, and policy mutation. Pi only shows prompts and relays
  approve/deny plus once/session scope decisions.

**Description**: This extension keeps the historical `sandbox` name for
compatibility, but it no longer implements a local Pi sandbox. It is an
AgentSH approval relay. When Pi runs inside an AgentSH session, AgentSH
may create session-scoped pending approvals for blocked file, command,
network, or Unix socket operations. The extension polls AgentSH's
approval UI Unix socket, displays those requests in Pi, and sends the
selected approve/deny decision and once/session resolution scope back to
AgentSH.

Pi does **not** receive AgentSH approver/admin API keys. The only AgentSH
runtime inputs are:

``` sh
AGENTSH_SESSION_ID=<session id>
AGENTSH_APPROVAL_UI_SOCKET=<peer-authorized AgentSH approval UI socket>
```

If either variable is missing, the relay stays inactive and does not
prompt.

**Approval flow**:

1. A Pi tool retries or performs an operation.
2. AgentSH enforces policy and, if configured, creates a pending approval.
3. The extension polls the approval UI socket with `list`.
4. Pi displays an approve/deny prompt. When AgentSH includes a canonical
   `scope_key`, Pi also offers `Approve for session` and `Deny for session`.
5. The extension sends `resolve` with the selected decision and `scope`.
6. AgentSH caches session-scoped choices for the current AgentSH session only.
   Pi does not cache approval decisions.

If another client resolves the same approval first, the Pi prompt is
aborted via `AbortSignal` and the stale approval is treated as already
handled. `approval not found for session` is not surfaced as a task
failure.

**Guidance tools**:

- `sandbox_allow_path`{.verbatim}
- `sandbox_allow_read_path`{.verbatim}
- `sandbox_allow_domain`{.verbatim}
- `sandbox_allow_unix_socket`{.verbatim}

These tools do not grant access and do not write local policy files. They
only explain that AgentSH owns grants and that the blocked operation
should be retried to trigger an AgentSH approval prompt.

**What this extension does not do**:

- no local OS sandboxing;
- no replacement of the `bash`{.verbatim} tool;
- no interception of native `read`{.verbatim}, `write`{.verbatim}, or
  `edit`{.verbatim} tools;
- no `.pi/sandbox.json`{.verbatim} project/global grant persistence;
- no use of `@anthropic-ai/sandbox-runtime`{.verbatim};
- no approver/admin bearer credential handling inside Pi;
- no local caching of session-scoped approvals.

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
- **pdf:** Ask the LLM to inspect a local PDF, render pages, or crop a page
  region for visual review
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
├── pdf/                # Local PDF inspection tools
│   └── index.ts
├── questionnaire/      # Multi-question tool
│   └── index.ts
├── sandbox/            # AgentSH approval relay UI
│   └── index.ts
├── subagent/           # Dynamic same-session child Pi processes
│   └── index.ts
├── slow-mode/          # Review gate for write/edit
│   ├── index.ts
│   ├── package.json    # Dependencies (diff package)
│   ├── package-lock.json
│   ├── bun.lock
│   └── node_modules/   # npm packages (gitignored)
├── package.json        # Package metadata and extension list
├── .gitignore          # Ignores node_modules, logs
├── AGENTS.md           # Agent context for AI assistants
└── README.org          # This file
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
