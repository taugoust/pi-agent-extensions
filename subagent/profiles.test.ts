import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { discoverAgentProfiles, resolveAgentProfileLaunch } from "./profiles.ts";

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-profiles-"));
  roots.push(root);
  return root;
}
async function profile(file: string, frontmatter: string, body = "Prompt body."): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\n${frontmatter}\n---\n\n${body}\n`);
}
async function discover(
  root: string,
  extra: Partial<Parameters<typeof discoverAgentProfiles>[0]> = {},
) {
  return discoverAgentProfiles({
    cwd: root,
    agentDir: path.join(root, "home"),
    projectTrusted: true,
    builtinDir: path.join(root, "builtins"),
    ...extra,
  });
}
afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("agent profile discovery", () => {
  it("applies builtin < user < project precedence and deterministic name ordering", async () => {
    const root = await temp();
    await profile(path.join(root, "builtins", "same.md"), "name: same\ndescription: Builtin");
    await profile(path.join(root, "builtins", "z.md"), "name: zed\ndescription: Z");
    await profile(
      path.join(root, "home", "agents", "nested", "same.md"),
      "name: same\ndescription: User",
    );
    await profile(path.join(root, ".pi", "agents", "same.md"), "name: same\ndescription: Project");
    const profiles = await discover(root);
    assert.deepEqual(
      profiles.map(({ name }) => name),
      ["same", "zed"],
    );
    assert.equal(profiles[0]?.description, "Project");
    assert.equal(profiles[0]?.source, "project");
  });

  it("parses strict supported fields, scalar and folded prompt values, block-list tools, and ignores chain files", async () => {
    const root = await temp();
    const builtinDir = path.join(root, "builtins");
    await profile(
      path.join(builtinDir, "valid.md"),
      `name: valid\ndescription: >-\n  First description\n  continued\ntools:\n  - read\n  - bash\nmodel: openai/model\nthinking: high`,
      "First paragraph.\n\nSecond paragraph.",
    );
    await profile(path.join(builtinDir, "skip.chain.md"), "not frontmatter");
    const [p] = await discover(root);
    assert.equal(p?.description, "First description continued");
    assert.equal(p?.systemPrompt, "First paragraph.\n\nSecond paragraph.");
    assert.deepEqual(p?.tools, ["read", "bash"]);
    assert.equal(p?.model, "openai/model");
    assert.equal(p?.thinking, "high");
    assert.equal(p?.filePath, path.join(builtinDir, "valid.md"));
  });

  it("rejects malformed UTF-8 instead of silently changing profile instructions", async () => {
    const root = await temp();
    const dir = path.join(root, "builtins");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(dir, "invalid.md"),
      Buffer.concat([
        Buffer.from("---\nname: invalid\ndescription: Invalid text\n---\n"),
        Buffer.from([0xff]),
      ]),
    );
    await assert.rejects(discover(root), /valid UTF-8/);
  });

  it("bounds descriptions and model selectors", async () => {
    const root = await temp();
    const dir = path.join(root, "builtins");
    await profile(
      path.join(dir, "description.md"),
      `name: long-description\ndescription: ${"x".repeat(513)}`,
    );
    await assert.rejects(discover(root), /description.*512 bytes/);
    await fs.rm(path.join(dir, "description.md"));
    await profile(
      path.join(dir, "model.md"),
      `name: long-model\ndescription: Model\nmodel: ${"m".repeat(513)}`,
    );
    await assert.rejects(discover(root), /model.*512 characters/);
  });

  it("rejects malformed delimiters, malformed YAML, duplicate keys, unknown fields, and empty bodies", async () => {
    const root = await temp();
    const dir = path.join(root, "builtins");
    const bad = [
      ["unclosed.md", "name: nope\ndescription: Missing end", "x"],
      ["syntax.md", "name: nope\ndescription: Yes\nnot a key", "x"],
      ["duplicate.md", "name: one\nname: two\ndescription: Bad", "x"],
      ["unknown.md", "name: nope\ndescription: Bad\nskills: all", "x"],
      ["missing.md", "name: nope", "x"],
      ["empty-prompt.md", "name: nope\ndescription: Bad", "   "],
      ["bad-level.md", "name: nope\ndescription: Bad\nthinking: extreme", "x"],
    ];
    for (const [name, front, body] of bad) {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, name!);
      await fs.writeFile(
        file,
        name === "unclosed.md" ? `---\n${front}\n` : `---\n${front}\n---\n${body}`,
      );
      await assert.rejects(discover(root), /Invalid agent profile/);
      await fs.rm(file);
    }
  });

  it("rejects duplicate parsed names within one layer", async () => {
    const root = await temp();
    await profile(path.join(root, "builtins", "one.md"), "name: same\ndescription: One");
    await profile(path.join(root, "builtins", "nested", "two.md"), "name: same\ndescription: Two");
    await assert.rejects(discover(root), /Duplicate agent profile name 'same' in builtin scope/);
  });

  it("applies scope and trust before touching project profile contents", async () => {
    const root = await temp();
    await profile(path.join(root, ".pi", "agents", "broken.md"), "not yaml", "body");
    assert.deepEqual(await discover(root, { projectTrusted: false }), []);
    assert.deepEqual(await discover(root, { projectTrusted: false, scope: "user" }), []);
    await assert.rejects(
      discover(root, { projectTrusted: false, scope: "project" }),
      /requires project trust/,
    );
    await assert.rejects(discover(root, { scope: "project" }), /Invalid agent profile/);
  });

  it("supports trusted user file symlinks but prevents project symlink escapes and directory traversal", async () => {
    const root = await temp();
    const externalRoot = await temp();
    const external = path.join(externalRoot, "outside.md");
    await profile(external, "name: linked\ndescription: Linked");
    const userDir = path.join(root, "home", "agents");
    await fs.mkdir(userDir, { recursive: true });
    await fs.symlink(external, path.join(userDir, "linked.md"));
    const projectDir = path.join(root, ".pi", "agents");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.symlink(external, path.join(projectDir, "escape.md"));
    await fs.symlink(path.join(root, "outside-dir"), path.join(projectDir, "linked-dir"));
    const userProfiles = await discover(root, { scope: "user" });
    assert.equal(userProfiles.find((p) => p.name === "linked")?.source, "user");
    await assert.rejects(discover(root), /Project agent profile file escapes trusted project root/);

    const escapedRoot = await temp();
    await fs.mkdir(path.join(escapedRoot, ".pi"), { recursive: true });
    await fs.symlink(externalRoot, path.join(escapedRoot, ".pi", "agents"));
    await assert.rejects(
      discover(escapedRoot),
      /Project agent profile directory escapes trusted project root/,
    );
  });

  it("propagates non-ENOENT discovery errors instead of falling back to builtins", async () => {
    const root = await temp();
    const userDir = path.join(root, "home", "agents");
    await fs.mkdir(userDir, { recursive: true });
    await fs.symlink(path.join(userDir, "cycle.md"), path.join(userDir, "cycle.md"));
    await assert.rejects(discover(root, { scope: "user" }), /ELOOP/);
  });

  it("parses the trusted reap policy only as an explicit boolean", async () => {
    const root = await temp();
    await profile(
      path.join(root, "builtins", "enabled.md"),
      "name: enabled\ndescription: Enabled\ncleanupWorktreesOnReap: true",
    );
    await profile(
      path.join(root, "builtins", "disabled.md"),
      "name: disabled\ndescription: Disabled\ncleanupWorktreesOnReap: false",
    );
    const profiles = await discover(root);
    assert.equal(profiles.find(({ name }) => name === "enabled")?.cleanupWorktreesOnReap, true);
    assert.equal(profiles.find(({ name }) => name === "disabled")?.cleanupWorktreesOnReap, false);
    await fs.rm(path.join(root, "builtins", "enabled.md"));
    await profile(
      path.join(root, "builtins", "enabled.md"),
      "name: enabled\ndescription: Enabled\ncleanupWorktreesOnReap: yes",
    );
    await assert.rejects(discover(root), /must be true or false/);
  });

  it("gives every builtin jobs and fetch, and only the worker edits", async () => {
    const root = await temp();
    const profiles = await discoverAgentProfiles({
      cwd: root,
      agentDir: path.join(root, "home"),
      projectTrusted: false,
    });
    assert.deepEqual(
      profiles.map(({ name }) => name),
      ["coordinator", "oracle", "reviewer", "scout", "worker"],
    );
    const toolsOf = (name: string) => profiles.find((profile) => profile.name === name)?.tools;
    for (const name of ["scout", "reviewer", "oracle"]) {
      assert.deepEqual(toolsOf(name), ["read", "bash", "background_job", "fetch"]);
    }
    assert.deepEqual(toolsOf("worker"), [
      "read",
      "bash",
      "edit",
      "write",
      "background_job",
      "fetch",
    ]);

    // Non-editing profiles can't get edit, write or delegation, not even by asking.
    const options = { defaultModel: "m" };
    const launch = (agent: string, tools?: string[]) =>
      resolveAgentProfileLaunch({ agent, ...(tools ? { tools } : {}) }, profiles, options);
    for (const name of ["scout", "reviewer", "oracle"]) {
      for (const tool of ["edit", "write", "subagent"]) {
        assert.ok(!launch(name).tools?.includes(tool));
        assert.throws(() => launch(name, [tool]));
      }
    }
    assert.equal(profiles.find(({ name }) => name === "coordinator")?.cleanupWorktreesOnReap, true);
    assert.equal(profiles.find(({ name }) => name === "coordinator")?.automaticWorktrees, true);
    for (const item of profiles.filter(({ name }) => name !== "coordinator"))
      assert.notEqual(item.automaticWorktrees, true);
    for (const item of profiles.filter(({ name }) => name !== "coordinator"))
      assert.notEqual(item.cleanupWorktreesOnReap, true);
    for (const item of profiles) assert.ok(item.systemPrompt.trim());
  });

  it("accepts explicit list syntax while rejecting malformed tool identifiers", async () => {
    const root = await temp();
    await profile(
      path.join(root, "builtins", "bad.md"),
      "name: bad\ndescription: Bad\ntools: read, not a tool",
    );
    await assert.rejects(discover(root), /malformed tool name/);
  });
});

describe("agent profile launch resolution", () => {
  const base = {
    name: "reviewer",
    description: "Review",
    systemPrompt: "Profile prompt",
    source: "builtin" as const,
    filePath: "/reviewer.md",
    model: "profile/model",
    thinking: "high",
    tools: ["read", "bash"],
  };
  it("rejects malformed explicit model and system prompt overrides", () => {
    for (const model of ["", "   ", null, 42]) {
      assert.throws(
        () =>
          resolveAgentProfileLaunch({ agent: "reviewer", model } as any, [base], {
            defaultModel: "m",
          }),
        /model.*non-empty string/,
      );
    }
    for (const systemPrompt of [null, 42, {}]) {
      assert.throws(
        () =>
          resolveAgentProfileLaunch({ agent: "reviewer", systemPrompt } as any, [base], {
            defaultModel: "m",
          }),
        /systemPrompt.*must be a string/,
      );
    }
  });
  it("uses launch model over profile model and suffix over profile thinking", () => {
    const result = resolveAgentProfileLaunch(
      { agent: "reviewer", model: "launch/model:low", task: "Inspect" },
      [base],
      { defaultModel: "provider/default:medium" },
    );
    assert.deepEqual(result, {
      model: "launch/model:low",
      task: "Inspect",
      systemPrompt: "Profile prompt",
      tools: ["read", "bash"],
      cleanupWorktreesOnReap: false,
      automaticWorktrees: false,
    });
  });
  it("applies profile thinking to model without suffix and uses default model for thinking-only profile", () => {
    assert.equal(
      resolveAgentProfileLaunch({ agent: "reviewer", model: "launch/model" }, [base], {
        defaultModel: "default:model",
      }).model,
      "launch/model:high",
    );
    const thinkingOnly = { ...base, model: undefined };
    assert.equal(
      resolveAgentProfileLaunch({ agent: "reviewer" }, [thinkingOnly], {
        defaultModel: "default:model",
      }).model,
      "default:model:high",
    );
  });
  it("appends explicit launch prompt after profile instructions and strips profile selectors", () => {
    const result = resolveAgentProfileLaunch(
      { agent: "reviewer", agentScope: "project", systemPrompt: "Extra", task: "Do it" },
      [base],
      { defaultModel: "default:model" },
    );
    assert.deepEqual(result, {
      task: "Do it",
      model: "profile/model:high",
      systemPrompt: "Profile prompt\n\nExtra",
      tools: ["read", "bash"],
      cleanupWorktreesOnReap: false,
      automaticWorktrees: false,
    });
  });
  it("preserves omitted profile tools and narrows explicit profile allowlists only", () => {
    const unrestricted = { ...base, tools: undefined };
    assert.equal(
      resolveAgentProfileLaunch({ agent: "reviewer" }, [unrestricted], { defaultModel: "m" }).tools,
      undefined,
    );
    assert.deepEqual(
      resolveAgentProfileLaunch({ agent: "reviewer", tools: ["read"] }, [base], {
        defaultModel: "m",
      }).tools,
      ["read"],
    );
    assert.deepEqual(
      resolveAgentProfileLaunch({ agent: "reviewer" }, [{ ...base, tools: [] }], {
        defaultModel: "m",
      }).tools,
      [],
    );
    assert.throws(
      () =>
        resolveAgentProfileLaunch({ agent: "reviewer", tools: ["write"] }, [base], {
          defaultModel: "m",
        }),
      /cannot widen profile/,
    );
  });
  it("resolves extension tools from profiles and only permits narrowing overrides", async () => {
    const root = await temp();
    const header = [
      "name: extended",
      "description: Extension tools",
      "tools: read, background_job, fetch, custom_tool, fetch",
    ].join("\n");
    await profile(path.join(root, "builtins", "extended.md"), header);
    const profiles = await discover(root);
    const resolve = (tools?: string[]) => {
      const params = { agent: "extended", ...(tools !== undefined ? { tools } : {}) };
      return resolveAgentProfileLaunch(params, profiles, { defaultModel: "m" });
    };

    // Duplicates are dropped and overrides can only narrow.
    assert.deepEqual(resolve().tools, ["read", "background_job", "fetch", "custom_tool"]);
    const narrowed = resolve(["fetch", "background_job", "fetch"]).tools;
    assert.deepEqual(narrowed, ["fetch", "background_job"]);
    assert.deepEqual(resolve([]).tools, []);
    for (const tools of [["write"], ["subagent"], ["fetch", "another_tool"]]) {
      assert.throws(() => resolve(tools));
    }

    // A profile without a tool list accepts any valid tool names.
    const noTools = { ...base, tools: undefined };
    const reviewer = (tools: unknown) => {
      const params = { agent: "reviewer", tools } as any;
      return resolveAgentProfileLaunch(params, [noTools], { defaultModel: "m" });
    };
    assert.deepEqual(reviewer(["fetch", "background_job"]).tools, ["fetch", "background_job"]);
    for (const tools of [["not a tool"], [""], [42], "fetch"]) {
      assert.throws(() => reviewer(tools));
    }
  });
  it("does not require profile lookup when no agent is selected, defaults policy off, rejects direct policy input, and errors on unknown profile", () => {
    assert.deepEqual(
      resolveAgentProfileLaunch({ agentScope: "user", task: "x" }, [], { defaultModel: "m" }),
      { task: "x", cleanupWorktreesOnReap: false, automaticWorktrees: false },
    );
    assert.equal(
      resolveAgentProfileLaunch({ agent: "reviewer" }, [base], { defaultModel: "m" })
        .cleanupWorktreesOnReap,
      false,
    );
    assert.equal(
      resolveAgentProfileLaunch(
        { agent: "reviewer" },
        [{ ...base, cleanupWorktreesOnReap: true }],
        { defaultModel: "m" },
      ).cleanupWorktreesOnReap,
      true,
    );
    assert.equal(
      resolveAgentProfileLaunch(
        { agent: "reviewer" },
        [{ ...base, cleanupWorktreesOnReap: false }],
        { defaultModel: "m" },
      ).cleanupWorktreesOnReap,
      false,
    );
    assert.throws(
      () => resolveAgentProfileLaunch({ cleanupWorktreesOnReap: true }, [], { defaultModel: "m" }),
      /trusted profile metadata/,
    );
    assert.equal(
      resolveAgentProfileLaunch(
        { name: "coordinator", displayName: "Coordinator", systemPrompt: "I am a coordinator" },
        [],
        { defaultModel: "m" },
      ).cleanupWorktreesOnReap,
      false,
    );
    for (const name of ["worker", "scout", "coordinator"])
      for (const policy of [true, false]) {
        assert.equal(
          resolveAgentProfileLaunch(
            { agent: name },
            [{ ...base, name, cleanupWorktreesOnReap: policy }],
            { defaultModel: "m" },
          ).cleanupWorktreesOnReap,
          policy,
        );
      }
    assert.throws(
      () => resolveAgentProfileLaunch({ agent: "missing" }, [], { defaultModel: "m" }),
      /Unknown agent profile/,
    );
  });
  it("enforces the final prompt byte bound", () => {
    const huge = { ...base, systemPrompt: "x".repeat(64 * 1024) };
    assert.throws(
      () =>
        resolveAgentProfileLaunch({ agent: "reviewer", systemPrompt: "extra" }, [huge], {
          defaultModel: "m",
        }),
      /exceeds 65536 bytes/,
    );
  });
});
