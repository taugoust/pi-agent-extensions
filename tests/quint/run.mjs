import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ModelMismatch, decode, replay } from "./native-task-driver.mjs";

const { values } = parseArgs({ options: {
  "out-dir": { type: "string" }, replay: { type: "string" },
  seed: { type: "string", default: "0x5eed" }, traces: { type: "string", default: "128" },
  steps: { type: "string", default: "40" },
} });
const count = Number(values.traces), steps = Number(values.steps);
assert.ok(Number.isSafeInteger(count) && count >= 1 && count <= 10000);
assert.ok(Number.isSafeInteger(steps) && steps >= 1 && steps <= 1000);
const here = dirname(fileURLToPath(import.meta.url));
const implementation = resolve(here, "../../subagent/resume.ts");
const { NativeTaskStore } = await import(pathToFileURL(implementation).href);
const output = values["out-dir"] ? resolve(values["out-dir"]) : mkdtempSync(join(tmpdir(), "pi-quint-traces-"));
mkdirSync(output, { recursive: true });
assert.equal(readdirSync(output).length, 0, "Use an empty output directory; existing evidence is never overwritten");
console.log(`Quint pilot artifacts: ${output}`);

async function checkedReplay(file, Store = NativeTaskStore) {
  try { return await replay(file, Store); }
  catch (error) {
    if (error instanceof ModelMismatch) {
      const trace = JSON.parse(readFileSync(file, "utf8"));
      trace.states = trace.states.slice(0, error.step + 1);
      const failure = join(output, "failure.itf.json");
      writeFileSync(failure, JSON.stringify(trace, null, 2) + "\n");
      console.error(`Failing prefix retained. Replay: node tests/quint/run.mjs --replay ${failure}`);
    }
    throw error;
  }
}

if (values.replay) {
  const result = await checkedReplay(resolve(values.replay));
  console.log(`Replay passed: ${result.transitions} transitions`);
} else {
  const quint = process.env.QUINT_BIN || "quint";
  const model = join(here, "native_task.qnt");
  const generate = (directory, step, samples, maxSteps) => {
    mkdirSync(directory);
    execFileSync(quint, ["run", model, "--backend=typescript", `--seed=${values.seed}`,
      `--max-samples=${samples}`, `--n-traces=${samples}`, `--max-steps=${maxSteps}`,
      `--step=${step}`, "--invariant=bounded", `--out-itf=${directory}/trace-{seq}.itf.json`, "--verbosity=1"],
    { stdio: "inherit", timeout: 120000 });
    const files = readdirSync(directory).filter(name => /^trace-\d+\.itf\.json$/.test(name)).sort().map(name => join(directory, name));
    assert.equal(files.length, samples, "Quint did not produce the requested traces");
    return files;
  };
  const random = generate(join(output, "random"), "step", count, steps);
  const history = generate(join(output, "history"), "historyStep", 1, 40);
  const files = [...random, ...history];
  const coverage = new Set();
  let transitions = 0;
  for (const file of files) {
    const result = await checkedReplay(file);
    transitions += result.transitions;
    for (const item of result.coverage) coverage.add(item);
  }
  const required = ["current_finish", "stale_finish", "previous_attempt_finish", "repeat_finish", "checkpoint", "resume",
    "running_resume_refused", "resume_order_low_then_high", "resume_order_high_then_low",
    "stop_child_refused", "stop_attempt_refused", "stop_running_refused", "stopped",
    "foreign_get", "foreign_list", "foreign_finish", "foreign_resume", "foreign_verifyStopped", "reconstruct"];
  assert.deepEqual(required.filter(item => !coverage.has(item)), [], "Generated corpus missed required cases; increase --traces/--steps");

  // Qualify the oracle against real, deliberately broken implementation copies.
  // Only a model comparison failure counts as a kill, never import/I/O errors.
  const source = readFileSync(implementation, "utf8");
  const mutations = [
    ["stale-finish", "if(r.childId!==childId)return;", "", random],
    ["attempt-increment", "r.attempt++;", "r.attempt+=0;", random],
    ["history-retention", "r.history=r.history.slice(-32);", "r.history=r.history.slice(-31);", history],
  ];
  const killed = [];
  for (const [name, before, after, corpus] of mutations) {
    assert.equal(source.split(before).length, 2, `Mutation ${name} no longer has one exact target; update the pilot`);
    const module = join(output, `mutant-${name}.ts`);
    writeFileSync(module, source.replace(before, after));
    const { NativeTaskStore: Mutant } = await import(pathToFileURL(module).href);
    let mismatch;
    for (const file of corpus) {
      try { await replay(file, Mutant); }
      catch (error) {
        if (!(error instanceof ModelMismatch)) throw error;
        mismatch = { file, step: error.step, command: error.command };
        break;
      }
    }
    assert.ok(mismatch, `Differential test failed to detect ${name}`);
    const trace = JSON.parse(readFileSync(mismatch.file, "utf8"));
    trace.states = trace.states.slice(0, mismatch.step + 1);
    writeFileSync(join(output, `counterexample-${name}.itf.json`), JSON.stringify(trace, null, 2) + "\n");
    killed.push({ mutation: name, trace: `counterexample-${name}.itf.json`, step: mismatch.step, command: mismatch.command });
    console.log(`Detected ${name} mutation at step ${mismatch.step}`);
  }
  const sha256 = text => createHash("sha256").update(text).digest("hex");
  const report = { seed: values.seed, backend: "typescript", quint: execFileSync(quint, ["--version"], { encoding: "utf8" }).trim(),
    randomTraces: count, randomSteps: steps, traces: files.length, transitions,
    modelSha256: sha256(readFileSync(model)), implementationSha256: sha256(source),
    traceStatesSha256: sha256(JSON.stringify(files.map(file => decode(JSON.parse(readFileSync(file, "utf8"))).states))),
    coverage: [...coverage].sort(), killed };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Passed ${files.length} traces / ${transitions} transitions; detected all ${killed.length} mutations`);
}
