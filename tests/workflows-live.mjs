// Explicitly opt-in: creates an owned disposable Paseo/Pi session and makes live model calls.
import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	realpath,
	access,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
if (process.env.PI_WORKFLOWS_LIVE !== "1") {
	console.log(
		"Skipped: set PI_WORKFLOWS_LIVE=1 to authorize the disposable live check.",
	);
	process.exit(0);
}
const install =
	process.env.PASEO_INSTALL_ROOT ??
	join(
		dirname(dirname(await realpath("/run/current-system/sw/bin/paseo"))),
		"lib",
		"paseo",
	);
const { connectToDaemon } = await import(
	pathToFileURL(join(install, "packages/cli/dist/utils/client.js"))
);
const { selectDaemonTarget } = await import(
	pathToFileURL(join(install, "packages/cli/dist/utils/daemon-target.js"))
);
const { createPaseoApi } = await import(
	pathToFileURL(join(install, "packages/client/dist/index.js"))
);
const bridge = process.env.PI_BRIDGE_SOURCE ?? resolve("../paseo-bridge-pi");
const { readRuntimeRecords, processStartToken } = await import(
	pathToFileURL(join(bridge, "shim/runtime-registry.js"))
);
const root = await mkdtemp(join(tmpdir(), "workflows-live-")),
	cwd = join(root, "repo"),
	linked = join(root, "linked"),
	evidencePath = resolve("plans/workflows-live-result.json");
await mkdir(cwd);
const git = (directory, ...args) =>
	execFileSync("git", args, {
		cwd: directory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
git(cwd, "init", "--template=", "--initial-branch=main");
git(cwd, "config", "core.hooksPath", "/dev/null");
git(cwd, "config", "user.name", "Workflow live check");
git(cwd, "config", "user.email", "live@example.invalid");
await writeFile(join(cwd, "seed.txt"), "disposable fixture\n");
git(cwd, "add", ".");
git(
	cwd,
	"-c",
	"commit.gpgsign=false",
	"commit",
	"-m",
	"Disposable live fixture",
);
const head = git(cwd, "rev-parse", "HEAD"),
	evidence = {
		startedAt: new Date().toISOString(),
		model: "openai/gpt-6-luna",
		root,
		checks: {},
		cleanup: [],
	};
let client,
	api,
	agent,
	mainWorkspace,
	linkedWorkspaceId,
	target,
	ownedRuntime,
	failure;
async function until(read, predicate, label, timeout = 30000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const result = await read();
		if (predicate(result)) return result;
		await delay(200);
	}
	throw Error(`Timed out: ${label}`);
}
const plugin = "paseo-permission-gate";
const status = () => client.invokePluginRpc(plugin, "workflows_status", target);
async function control(fields) {
	const current = await status();
	assert.equal(current.available, true);
	return client.invokePluginRpc(plugin, "workflows_control", {
		...target,
		expectedRuntimeEpoch: current.runtimeEpoch,
		request: {
			sessionId: current.sessionId,
			serviceEpoch: current.snapshot.serviceEpoch,
			requestId: randomUUID(),
			...fields,
		},
	});
}
async function start(action, fields = {}) {
	const current = await status();
	return control({
		operation: "start",
		action,
		expectedGoalId: current.snapshot.goal?.id ?? null,
		...fields,
	});
}
async function answer(kind, title, value) {
	const current = await until(
		status,
		(s) => s.snapshot?.dialog,
		"expected dialog",
	);
	const d = current.snapshot.dialog;
	assert.equal(d.kind, kind);
	assert.match(d.title, title);
	return control({
		operation: "send",
		operationId: d.operationId,
		dialogId: d.id,
		value: typeof value === "function" ? value(d) : value,
	});
}
try {
	client = await connectToDaemon({
		target: selectDaemonTarget({}, process.env, true),
	});
	api = createPaseoApi(client);
	mainWorkspace = await api.workspaces.create({
		source: { kind: "directory", path: cwd },
		title: "Disposable Workflows live check",
		idempotencyKey: `workflows-live:${randomUUID()}`,
	});
	assert.equal((await mainWorkspace.refresh()).workspaceDirectory, cwd);
	agent = await mainWorkspace.agents.create({
		config: { provider: "pi/openai/gpt-6-luna", thinkingOptionId: "low" },
		title: "Disposable Workflows live check",
		env: { PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0" },
	});
	evidence.agentId = agent.id;
	evidence.workspaceId = mainWorkspace.id;
	const commands = await agent.commands();
	assert.ok(
		commands.commands.some((c) => c.name === "goal" || c.name === "/goal"),
		"installed Goal command must be loaded before any prompt",
	);
	const info = await agent.refresh();
	assert.equal(info.agent.cwd, cwd);
	assert.equal(info.agent.workspaceId, mainWorkspace.id);
	target = { agentId: agent.id, workspaceId: mainWorkspace.id };
	const ready = await until(
		status,
		(s) => s.available && s.snapshot && !s.snapshot.busy,
		"installed workflow service",
		60000,
	);
	assert.equal(
		ready.snapshot.model,
		"openai/gpt-6-luna",
		"refuse live inference on a different model",
	);
	assert.equal(ready.snapshot.goal, null);
	assert.ok(
		ready.snapshot.limits.automaticTurns > 0 &&
			ready.snapshot.limits.automaticTurns <= 3,
	);
	ownedRuntime = readRuntimeRecords().find(
		(record) =>
			record.agentId === agent.id &&
			record.cwd === cwd &&
			typeof record.processStartToken === "string" &&
			record.processStartToken &&
			record.processStartToken === processStartToken(record.pid),
	);
	await start("worktree.add");
	await answer("input", /Branch/, "workflow-live");
	await answer("input", /Start point/, "");
	await answer("input", /Worktree path/, linked);
	await answer("confirm", /Create Git worktree/, (dialog) => {
		assert.ok(dialog.message.includes(head));
		assert.ok(dialog.message.includes(linked));
		return true;
	});
	await until(
		status,
		(s) =>
			!s.snapshot?.busy && s.snapshot?.worktrees.some((t) => t.path === linked),
		"worktree creation",
	);
	assert.equal(git(linked, "rev-parse", "HEAD"), head);
	evidence.checks.createdAtApprovedCommit = true;
	const opened = await start("worktree.open", { path: linked });
	linkedWorkspaceId = opened.openedWorkspaceId;
	assert.ok(linkedWorkspaceId && linkedWorkspaceId !== mainWorkspace.id);
	const openedInfo = await api.workspaces.ref(linkedWorkspaceId).refresh();
	assert.equal(openedInfo.workspaceDirectory, linked);
	assert.equal((await agent.refresh()).agent.workspaceId, mainWorkspace.id);
	evidence.checks.nativeWorkspaceOpenPreservedSession = true;
	await writeFile(join(linked, "keep.txt"), "must survive refusal");
	await start("worktree.remove");
	await answer("select", /Remove linked worktree/, (d) => {
		const choice = d.options.find((value) => value.includes(linked));
		assert.ok(choice);
		return choice;
	});
	const refused = await until(
		status,
		(s) => !s.snapshot?.busy,
		"dirty removal refusal",
	);
	assert.match(refused.snapshot.notice, /Removal refused/);
	await access(join(linked, "keep.txt"));
	evidence.checks.dirtyRemovalRefused = true;
	await rm(join(linked, "keep.txt"));
	await start("worktree.remove");
	await answer("select", /Remove linked worktree/, (d) =>
		d.options.find((value) => value.includes(linked)),
	);
	await answer("confirm", /Remove Git worktree|Remove worktree/, true);
	await until(
		status,
		(s) =>
			!s.snapshot?.busy &&
			!s.snapshot?.worktrees.some((t) => t.path === linked),
		"worktree removal",
	);
	await assert.rejects(access(linked));
	assert.ok(git(cwd, "show-ref", "refs/heads/workflow-live"));
	evidence.checks.cleanRemovalPreservedBranch = true;
	const proof = `workflow-live-proof-${randomUUID()}`;
	const objective = `In this disposable fixture only, use write to create goal-proof.txt containing exactly ${JSON.stringify(proof + "\n")}. Then use read to verify the file. Finish with goal_complete using the current goal_id and a summary of the verified evidence. Do not modify any other file, commit, push, use subagents, run shell commands, or use network tools. This is a bounded live smoke test.`;
	await start("goal.start", { objective, tokenBudget: 100000 });
	await answer("confirm", /Start Goal/, true);
	const completed = await until(
		async () => {
			const state = await status();
			const current = await agent.refresh();
			if (current?.agent.pendingPermissions?.length)
				throw Error(
					"Unexpected live permission request; test stopped without automatic approval",
				);
			if (
				state.snapshot?.goal &&
				["blocked", "usage_limited", "budget_limited", "paused"].includes(
					state.snapshot.goal.status,
				)
			)
				throw Error(`Live Goal stopped: ${state.snapshot.goal.status}`);
			return state;
		},
		(s) =>
			s.snapshot?.lastCompletion?.text === objective &&
			!!s.snapshot.lastCompletion.summary,
		"live Goal completion",
		90000,
	);
	assert.equal(
		await readFile(join(cwd, "goal-proof.txt"), "utf8"),
		proof + "\n",
	);
	assert.equal(completed.snapshot.goal, null);
	evidence.checks.liveGoalCompletedAndArtifactVerified = true;
	evidence.goalSummary = completed.snapshot.lastCompletion.summary;
	evidence.proof = proof;
	console.log(
		JSON.stringify({ phase: "live checks passed", checks: evidence.checks }),
	);
} catch (error) {
	failure = error;
	evidence.error = error instanceof Error ? error.message : String(error);
} finally {
	const errors = [];
	if (agent) {
		try {
			await client.cancelAgent(agent.id);
		} catch (error) {
			errors.push(`cancel: ${error.message}`);
		}
		try {
			await agent.archive();
			evidence.cleanup.push("owned agent archived");
		} catch (error) {
			errors.push(`archive: ${error.message}`);
		}
		// Only the process whose identity and disposable cwd we captured is eligible.
		if (
			ownedRuntime?.processStartToken &&
			ownedRuntime.cwd === cwd &&
			ownedRuntime.processStartToken === processStartToken(ownedRuntime.pid)
		) {
			try {
				process.kill(ownedRuntime.pid, "SIGTERM");
				await until(
					async () => processStartToken(ownedRuntime.pid),
					(token) => token !== ownedRuntime.processStartToken,
					"owned Pi exit",
					10000,
				);
				evidence.cleanup.push("owned Pi process exited");
			} catch (error) {
				errors.push(`owned process: ${error.message}`);
			}
		}
		try {
			await client.deleteAgent(agent.id);
			evidence.cleanup.push("owned agent deleted");
		} catch (error) {
			errors.push(`delete: ${error.message}`);
		}
	}
	for (const id of [linkedWorkspaceId, mainWorkspace?.id].filter(Boolean)) {
		try {
			const result = await api.workspaces.archive(id);
			if (result.error) throw Error(result.error);
			evidence.cleanup.push(`workspace archived: ${id}`);
		} catch (error) {
			errors.push(`workspace cleanup: ${error.message}`);
		}
	}
	try {
		const remaining = readRuntimeRecords().filter(
			(r) =>
				r.cwd === cwd &&
				r.processStartToken &&
				r.processStartToken === processStartToken(r.pid),
		);
		if (remaining.length)
			errors.push(
				`Owned test cwd still has live Pi runtimes: ${remaining.map((r) => r.pid).join(",")}`,
			);
	} catch (error) {
		errors.push(`runtime cleanup verification: ${error.message}`);
	}
	await api?.dispose();
	await client?.close();
	if (!errors.length) {
		await rm(root, { recursive: true, force: true });
		evidence.cleanup.push("disposable fixture removed");
	} else {
		evidence.cleanupErrors = errors;
		failure ??= Error("Live test cleanup needs inspection");
	}
	evidence.finishedAt = new Date().toISOString();
	await mkdir(dirname(evidencePath), { recursive: true });
	await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
	console.log(`Evidence: ${evidencePath}`);
}
if (failure) throw failure;
