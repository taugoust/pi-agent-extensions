import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import pdfExtension from "./index.js";
import type {
  AgentSHExecOptions,
  AgentSHExecResult,
  AgentSHPiAPI,
  AgentSHReadFileOptions,
} from "../sandbox/api.js";

function createPi() {
  const tools = new Map<string, any>();
  return {
    tools,
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
  };
}

function context(cwd: string) {
  return { cwd, hasUI: false, mode: "json" } as any;
}

async function execute(
  pi: ReturnType<typeof createPi>,
  name: string,
  params: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
) {
  const tool = pi.tools.get(name);
  assert.ok(tool, `${name} was not registered`);
  return await tool.execute(`call-${name}`, params, signal, undefined, context(cwd));
}

async function writeExecutable(path: string, body: string) {
  await writeFile(path, `#!${process.execPath}\n${body}\n`, "utf8");
  await chmod(path, 0o755);
}

async function createFakePdfTools(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeExecutable(join(bin, "pdfinfo"), `
if (process.argv[2] === "-v") {
  console.error("pdfinfo version fixture-1");
} else {
  console.log(["Title: Supervisor Fixture", "Author: Pi", "Pages: 2", "Page size: 612 x 792 pts", "Encrypted: no", "PDF version: 1.7"].join("\\n"));
}
`);
  await writeExecutable(join(bin, "pdftoppm"), `
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
if (process.argv[2] === "-v") {
  console.error("pdftoppm version fixture-1");
} else {
  const outputBase = process.argv.at(-1);
  mkdirSync(dirname(outputBase), { recursive: true });
  writeFileSync(outputBase + ".png", Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4,5,6,7,8]));
}
`);
  await writeExecutable(join(bin, "magick"), `
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-version") {
  console.log("ImageMagick fixture-1");
} else if (args[0] === "identify") {
  console.log("640 480");
} else {
  const source = args[0];
  const output = args.at(-1);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, readFileSync(source));
}
`);
  await writeExecutable(join(bin, "pdftotext"), `
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-v") {
  console.error("pdftotext version fixture-1");
} else {
  const output = args.at(-1);
  const text = "alpha beta gamma\\nsecond line\\n";
  if (output === "-") process.stdout.write(text);
  else {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, text);
  }
}
`);
  await writeExecutable(join(bin, "pdfimages"), `
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "-v") {
  console.error("pdfimages version fixture-1");
} else {
  const prefix = args.at(-1);
  mkdirSync(dirname(prefix), { recursive: true });
  writeFileSync(prefix + "-000.png", Buffer.from([137,80,78,71,13,10,26,10,9,8,7,6]));
}
`);
  return bin;
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function shellExec(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<AgentSHExecResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "bash",
      ["-c", command],
      {
        cwd,
        env: process.env,
        signal,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted || error?.name === "AbortError") {
          reject(abortError());
          return;
        }
        const exitCode = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
        resolvePromise({ exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

class FakeAgentSHAPI implements AgentSHPiAPI {
  readonly execCalls: Array<{ command: string; cwd?: string; timeout_ms?: number; actor?: unknown; signal?: AbortSignal }> = [];
  readonly readCalls: Array<{ path: string; options: AgentSHReadFileOptions }> = [];
  readonly writeCalls: Array<{ path: string; content: string; options: unknown }> = [];
  active = true;
  lastError = "";
  denyNextCommand = false;
  missNextCommand = false;

  constructor(readonly workspace: string) {}

  #realPath(path: string): string {
    if (path === "/workspace") return this.workspace;
    if (path.startsWith("/workspace/")) return join(this.workspace, path.slice("/workspace/".length));
    return path;
  }

  toSupervisorPath(path: string, cwd = this.workspace): string {
    const slashPath = path.replace(/\\/g, "/");
    const slashWorkspace = this.workspace.replace(/\\/g, "/");
    const mapAbsolute = (value: string) => {
      if (value === slashWorkspace) return "/workspace";
      if (value.startsWith(`${slashWorkspace}/`)) return `/workspace/${value.slice(slashWorkspace.length + 1)}`;
      return value;
    };
    if (posix.isAbsolute(slashPath)) return posix.normalize(mapAbsolute(slashPath));
    const supervisorCwd = mapAbsolute(cwd.replace(/\\/g, "/"));
    return posix.resolve(supervisorCwd.startsWith("/") ? supervisorCwd : "/workspace", slashPath);
  }

  async exec(
    commandOrParams: string | { command: string; cwd?: string; timeout_ms?: number; actor?: any },
    options: AgentSHExecOptions = {},
  ): Promise<AgentSHExecResult> {
    const params = typeof commandOrParams === "string" ? { command: commandOrParams } : commandOrParams;
    this.execCalls.push({ ...params, signal: options.signal });
    if (options.signal?.aborted) throw abortError();
    if (this.denyNextCommand) {
      this.denyNextCommand = false;
      throw new Error("policy denied PDF command");
    }
    if (this.missNextCommand) {
      this.missNextCommand = false;
      return { exitCode: 127, stdout: "", stderr: "command not found" };
    }
    const mappedCommand = params.command.replaceAll("/workspace", this.workspace);
    const mappedCwd = this.#realPath(params.cwd ?? "/workspace");
    return await shellExec(mappedCommand, mappedCwd, options.signal, params.timeout_ms);
  }

  async readFile(path: string, options: AgentSHReadFileOptions = {}) {
    this.readCalls.push({ path, options });
    if (options.signal?.aborted) throw abortError();
    const real = this.#realPath(this.toSupervisorPath(path, options.cwd));
    const bytes = await readFile(real);
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    const selected = bytes.subarray(0, maxBytes);
    return {
      path: this.toSupervisorPath(path, options.cwd),
      size: bytes.length,
      max_bytes: maxBytes,
      truncated: selected.length < bytes.length,
      byte_truncated: selected.length < bytes.length,
      encoding: "base64",
      content: selected.toString("base64"),
    };
  }

  async writeFile(path: string, content: string, options: any = {}) {
    this.writeCalls.push({ path, content, options });
    if (options.signal?.aborted) throw abortError();
    const virtual = this.toSupervisorPath(path, options.cwd);
    const real = this.#realPath(virtual);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, content, "utf8");
    return { path: virtual, bytes_written: Buffer.byteLength(content) };
  }

  async editFile() { return {}; }
  async spawnSubagent() { return {}; }
  async resolveApproval() { return {}; }
  async refreshDirenv() {
    return { state: "no_envrc" as const, set_count: 0, unset_count: 0, rejected_count: 0, generation: 0, duration_ms: 0 };
  }
  getSupervisorMetadata() {
    return {
      session_id: "pdf-test-session",
      workspace_mode: "shadow",
      virtual_root: "/workspace",
      real_workspace: this.workspace,
      worktree: this.workspace,
      workspace_roots: [{ name: basename(this.workspace), real: this.workspace, work: this.workspace }],
    };
  }
  getSupervisorState() {
    return {
      active: this.active,
      status: this.active ? "connected" as const : "error" as const,
      source: "agentsh-env" as const,
      socketPath: "/tmp/fake-supervisor.sock",
      sessionId: "pdf-test-session",
      metadata: this.getSupervisorMetadata(),
      lastError: this.lastError || undefined,
    };
  }
}

function clearSupervisionEnv() {
  for (const name of [
    "PI_AUTO",
    "PI_SUPERVISED",
    "PI_AGENTSH_REMOTE",
    "PI_AGENTSH_REMOTE_CWD",
    "PI_AGENTSH_READ_MODE",
    "AGENTSH_SESSION_SUPERVISOR",
  ]) delete process.env[name];
  delete globalThis.__AGENTSH_PI__;
}

async function assertRejectsMessage(action: () => Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, "expected operation to reject");
  assert.match(caught.message, pattern);
  return caught;
}

const root = await mkdtemp(join(tmpdir(), "pi-pdf-check-"));
const originalPath = process.env.PATH;
try {
  const fakeBin = await createFakePdfTools(root);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

  const nativeWorkspace = join(root, "native");
  await mkdir(nativeWorkspace, { recursive: true });
  await writeFile(join(nativeWorkspace, "input.pdf"), "%PDF fixture\n", "utf8");
  await writeFile(join(nativeWorkspace, "source.png"), Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]));

  clearSupervisionEnv();
  {
    const pi = createPi();
    pdfExtension(pi as any);
    assert.deepEqual([...pi.tools.keys()].sort(), [
      "pdf_crop_image",
      "pdf_extract_images",
      "pdf_extract_text",
      "pdf_info",
      "pdf_render_pages",
    ]);

    const info = await execute(pi, "pdf_info", { pdfPath: "input.pdf" }, nativeWorkspace);
    assert.equal(info.details.pages, 2);
    assert.equal(info.details.sourcePdf, join(nativeWorkspace, "input.pdf"));

    const rendered = await execute(pi, "pdf_render_pages", {
      pdfPath: "input.pdf",
      pages: "1-2",
      outputDir: "rendered",
      attachImages: true,
    }, nativeWorkspace);
    assert.equal(rendered.details.rendered.length, 2);
    assert.equal(rendered.content.filter((item: any) => item.type === "image").length, 2);
    assert.ok((await stat(join(nativeWorkspace, "rendered", "input-page-001.png.json"))).isFile());

    const cropped = await execute(pi, "pdf_crop_image", {
      sourceImagePath: "source.png",
      crop: { x: 1, y: 2, width: 20, height: 30 },
      outputDir: "crops",
      attachImage: true,
    }, nativeWorkspace);
    assert.equal(cropped.details.dimensions.width, 640);
    assert.ok(cropped.content.some((item: any) => item.type === "image"));

    const inlineText = await execute(pi, "pdf_extract_text", {
      pdfPath: "input.pdf",
      pages: "1",
      maxChars: 5,
    }, nativeWorkspace);
    assert.match(inlineText.content[0].text, /alpha\n\n\[truncated to 5 chars\]/);

    await execute(pi, "pdf_extract_text", {
      pdfPath: "input.pdf",
      outputPath: "text/output.txt",
    }, nativeWorkspace);
    assert.equal(await readFile(join(nativeWorkspace, "text", "output.txt"), "utf8"), "alpha beta gamma\nsecond line\n");
    assert.ok((await stat(join(nativeWorkspace, "text", "output.txt.json"))).isFile());

    const extracted = await execute(pi, "pdf_extract_images", {
      pdfPath: "input.pdf",
      outputDir: "images",
    }, nativeWorkspace);
    assert.equal(extracted.details.images.length, 1);
    assert.ok((await stat(join(nativeWorkspace, "images", "input-image-000.png"))).isFile());

    const limited = await execute(pi, "pdf_render_pages", {
      pdfPath: "input.pdf",
      pages: "1",
      outputDir: "limited",
      attachImages: true,
      maxAttachBytes: 4,
    }, nativeWorkspace);
    assert.equal(limited.details.rendered[0].attachment.attached, false);
    assert.match(limited.details.rendered[0].attachment.skippedReason, /larger than maxAttachBytes=4/);
  }

  const supervisedWorkspace = join(root, "supervised");
  await mkdir(supervisedWorkspace, { recursive: true });
  await writeFile(join(supervisedWorkspace, "input.pdf"), "%PDF supervised fixture\n", "utf8");
  await writeFile(join(supervisedWorkspace, "source.png"), Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]));
  const api = new FakeAgentSHAPI(supervisedWorkspace);
  globalThis.__AGENTSH_PI__ = api;
  process.env.PI_AUTO = "1";
  process.env.PI_AGENTSH_REMOTE = "ssh";
  process.env.PI_AGENTSH_REMOTE_CWD = "/workspace";
  process.env.PI_AGENTSH_READ_MODE = "supervised";
  process.env.AGENTSH_SESSION_SUPERVISOR = "unix:///tmp/fake-supervisor.sock";

  {
    const pi = createPi();
    pdfExtension(pi as any);

    const info = await execute(pi, "pdf_info", { pdfPath: "input.pdf", timeoutMs: 1234 }, supervisedWorkspace);
    assert.equal(info.details.sourcePdf, "/workspace/input.pdf");
    assert.equal(info.details.pages, 2);

    const rendered = await execute(pi, "pdf_render_pages", {
      pdfPath: supervisedWorkspace + "/input.pdf",
      pages: "1",
      outputDir: supervisedWorkspace + "/rendered",
      attachImages: true,
      timeoutMs: 2345,
    }, supervisedWorkspace);
    assert.equal(rendered.details.outputDir, "/workspace/rendered");
    assert.equal(rendered.details.rendered[0].outputPath, "/workspace/rendered/input-page-001.png");
    assert.ok(rendered.content.some((item: any) => item.type === "image"));
    assert.ok((await stat(join(supervisedWorkspace, "rendered", "input-page-001.png"))).isFile());

    const cropped = await execute(pi, "pdf_crop_image", {
      sourceImagePath: "source.png",
      crop: { x: 0, y: 0, width: 10, height: 10 },
      outputPath: "crops/crop.png",
      attachImage: true,
    }, supervisedWorkspace);
    assert.equal(cropped.details.outputPath, "/workspace/crops/crop.png");

    const inlineText = await execute(pi, "pdf_extract_text", {
      pdfPath: "input.pdf",
      pages: "1-2",
    }, supervisedWorkspace);
    assert.match(inlineText.content[0].text, /alpha beta gamma/);

    await execute(pi, "pdf_extract_text", {
      pdfPath: "input.pdf",
      outputPath: "text/output.txt",
    }, supervisedWorkspace);
    assert.equal(await readFile(join(supervisedWorkspace, "text", "output.txt"), "utf8"), "alpha beta gamma\nsecond line\n");

    const extracted = await execute(pi, "pdf_extract_images", {
      pdfPath: "input.pdf",
      outputDir: "images",
      pages: "2",
    }, supervisedWorkspace);
    assert.equal(extracted.details.outputDir, "/workspace/images");
    assert.equal(extracted.details.images[0].imagePath, "/workspace/images/input-image-000.png");

    assert.ok(api.execCalls.length > 0);
    assert.ok(api.execCalls.every((call) => call.cwd === "/workspace"));
    assert.ok(api.execCalls.every((call) => !call.command.includes(supervisedWorkspace)));
    assert.ok(api.execCalls.some((call) => call.command.startsWith("pdfinfo ") && call.timeout_ms === 1234));
    assert.ok(api.execCalls.some((call) => call.command.startsWith("pdftoppm ") && call.timeout_ms === 2345));
    assert.ok(api.execCalls.every((call) => (call.actor as any)?.kind === "extension"));
    assert.ok(api.writeCalls.some((call) => call.path === "/workspace/rendered/input-page-001.png.json"));
    assert.ok(api.readCalls.some((call) => call.path === "/workspace/rendered/input-page-001.png" && call.options.maxBytes === 4 * 1024 * 1024));
    assert.ok(api.readCalls.some((call) => call.options.limit === 2_147_483_647));

    const limited = await execute(pi, "pdf_render_pages", {
      pdfPath: "input.pdf",
      pages: "1",
      outputDir: "limited",
      attachImages: true,
      maxAttachBytes: 4,
    }, supervisedWorkspace);
    assert.equal(limited.details.rendered[0].attachment.attached, false);
    assert.match(limited.details.rendered[0].attachment.skippedReason, /larger than maxAttachBytes=4/);

    api.denyNextCommand = true;
    await assertRejectsMessage(
      () => execute(pi, "pdf_info", { pdfPath: "input.pdf" }, supervisedWorkspace),
      /AgentSH PDF command failed: pdfinfo.*policy denied/s,
    );

    api.missNextCommand = true;
    await assertRejectsMessage(
      () => execute(pi, "pdf_info", { pdfPath: "input.pdf" }, supervisedWorkspace),
      /Missing required command in the AgentSH supervisor runtime: pdfinfo/,
    );

    const controller = new AbortController();
    controller.abort();
    const cancelled = await assertRejectsMessage(
      () => execute(pi, "pdf_info", { pdfPath: "input.pdf" }, supervisedWorkspace, controller.signal),
      /aborted/,
    );
    assert.equal(cancelled.name, "AbortError");
  }

  api.active = false;
  api.lastError = "supervisor unavailable";
  {
    const pi = createPi();
    pdfExtension(pi as any);
    await assertRejectsMessage(
      () => execute(pi, "pdf_info", { pdfPath: "input.pdf" }, supervisedWorkspace),
      /require the active AgentSH supervisor.*supervisor unavailable/s,
    );
  }

  console.log("pdf backend checks passed");
} finally {
  process.env.PATH = originalPath;
  clearSupervisionEnv();
  await rm(root, { recursive: true, force: true });
}
