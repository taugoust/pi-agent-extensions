import assert from "node:assert/strict";
import * as approvalModel from "./approval-model.js";
import {
  approvalChoices,
  approvalPresentation,
  approvalResolutionBody,
  approvalTitle,
  resolveChoice,
  type ApprovalChoice,
  type ApprovalRequest,
  type ApprovalResolution,
} from "./approval-model.js";

assert.deepEqual(Object.keys(approvalModel).sort(), [
  "approvalChoices",
  "approvalPresentation",
  "approvalResolutionBody",
  "approvalTitle",
  "resolveChoice",
]);

const titleCases: Array<{
  name: string;
  approval: ApprovalRequest;
  expected: string;
}> = [
  {
    name: "target",
    approval: { id: "approval-1", kind: "network", target: "example.com:443", command_id: "command-1" },
    expected: "network: example.com:443",
  },
  {
    name: "command fallback",
    approval: { id: "approval-2", kind: "command", command_id: "command-2" },
    expected: "command: command-2",
  },
  {
    name: "default kind and id fallback",
    approval: { id: "approval-3" },
    expected: "approval: approval-3",
  },
];

for (const testCase of titleCases) {
  assert.equal(approvalTitle(testCase.approval), testCase.expected, testCase.name);
}

const presentationCases: Array<{
  name: string;
  approval: ApprovalRequest;
  expected: { title: string; details: string[] };
}> = [
  {
    name: "file metadata outside workspace with nested subagent actor",
    approval: {
      id: "file-stat",
      kind: "file",
      target: "/workspace/src/.git",
      rule: "approve-outside-workspace-reads",
      message: "Pi wants to read outside the opened workspace: {{.Path}}",
      fields: {
        operation: "stat",
        scope_operation: "read",
        actor: { kind: "subagent", label: "dependency audit", subagent_id: "subagent-1" },
      },
    },
    expected: {
      title: "Inspect metadata for this path outside the opened workspace?",
      details: ["/workspace/src/.git", "Requested by dependency audit (subagent)"],
    },
  },
  {
    name: "command reason and readable Nix executable",
    approval: {
      id: "command-run",
      kind: "command",
      target: "/nix/store/aaaaaaaa-deploy/bin/deploy-hw",
      message: "The project wants to access or modify FPGA hardware state.",
      actor: { kind: "tool", label: "Pi supervised tool" },
      fields: {
        command: "/nix/store/aaaaaaaa-deploy/bin/deploy-hw",
        args: ["deploy-hw", "/scratch/demo bitstream.pdi"],
      },
    },
    expected: {
      title: "Access or modify FPGA hardware state?",
      details: ["deploy-hw \"/scratch/demo bitstream.pdi\"", "Requested by Pi supervised tool"],
    },
  },
  {
    name: "network promotes SSH context and hides templates",
    approval: {
      id: "network-ssh",
      kind: "network",
      target: "login.example:22",
      rule: "approve-unknown-ssh",
      message: "Pi wants to connect over SSH to: {{.RemoteAddr}}:{{.RemotePort}}",
    },
    expected: {
      title: "Connect over SSH?",
      details: ["login.example:22"],
    },
  },
  {
    name: "policy overlay paths and rule counts",
    approval: {
      id: "policy-overlay",
      kind: "policy_overlay",
      fields: {
        project_root: "/workspace/project",
        overlay_paths: ["one.toml", "two.toml", "three.toml", "four.toml", "five.toml"],
        overlay_names: ["ignored-name"],
        rule_counts: { file_rules: 2, network_rules: 1, connect_redirects: 3, package_rules: 0 },
      },
    },
    expected: {
      title: "Use project-local policy overlays?",
      details: [
        "/workspace/project",
        "Overlays: one.toml, two.toml, three.toml, four.toml, …",
        "Rules: 2 file, 1 network, 3 connect redirect",
      ],
    },
  },
  {
    name: "package findings and non-redundant message",
    approval: {
      id: "package-operation",
      kind: "package",
      target: "npm install",
      message: "Pi wants to install dependencies",
      fields: { findings: "3" },
    },
    expected: {
      title: "Allow this package operation?",
      details: ["npm install", "Findings: 3", "install dependencies"],
    },
  },
  {
    name: "flagged skill details",
    approval: {
      id: "skillcheck",
      kind: "skillcheck",
      fields: {
        skill_name: "release-helper",
        skill_path: "/workspace/.pi/skills/release-helper.md",
        summary: "Uses a flagged shell pattern",
        skill_sha256: "abcdef0123456789",
      },
    },
    expected: {
      title: "Allow this flagged skill?",
      details: [
        "release-helper",
        "/workspace/.pi/skills/release-helper.md",
        "Uses a flagged shell pattern",
        "SHA-256: abcdef012345…",
      ],
    },
  },
  {
    name: "unknown kind and actor kind",
    approval: {
      id: "socket-operation",
      kind: "unix_socket",
      target: "/run/example.sock",
      message: "Pi wants to connect to local daemon",
      actor: { kind: "extension" },
    },
    expected: {
      title: "Allow this unix socket?",
      details: ["/run/example.sock", "connect to local daemon", "Requested by extension"],
    },
  },
];

for (const testCase of presentationCases) {
  assert.deepEqual(approvalPresentation(testCase.approval), testCase.expected, testCase.name);
}

function choiceRows(choices: ApprovalChoice[]) {
  return choices.map((choice) => [
    choice.label,
    choice.decision,
    choice.scope,
    choice.scope_kind ?? null,
    choice.scope_key ?? null,
    choice.reason,
  ]);
}

const choiceCases: Array<{
  name: string;
  approval: ApprovalRequest;
  expected: Array<Array<string | null | undefined>>;
}> = [
  {
    name: "unscoped approval",
    approval: {
      id: "unscoped",
      kind: "file",
      fields: { scope_options: [null, {}, { scope_kind: "file", scope_key: " " }] },
    },
    expected: [
      ["Deny once", "deny", "once", null, null, "denied in parent Pi"],
      ["Allow once", "approve", "once", null, null, "approved in parent Pi"],
    ],
  },
  {
    name: "network destination and command lifetime",
    approval: {
      id: "network-scopes",
      kind: "network",
      target: "login.example:22",
      fields: {
        scope_kind: "network",
        scope_key: "network:login.example:22",
        scope_label: "login.example:22",
        scope_operation: "connect",
        scope_path: "login.example:22",
        scope_rule: "approve-unknown-ssh",
        scope_prefix: false,
        scope_options: [
          {
            scope_kind: "command-run",
            scope_key: "command-run:all-approvals",
            scope_label: "all requests for this command invocation",
            scope_lifetime: "command",
          },
        ],
      },
    },
    expected: [
      ["Deny", "deny", "once", null, null, "denied in parent Pi"],
      ["Allow once", "approve", "once", null, null, "approved in parent Pi"],
      ["Allow for session", "approve", "session", "network", "network:login.example:22", "approved for session network destination: login.example:22 in parent Pi"],
      ["Allow all accesses for command", "approve", "once", "command-run", "command-run:all-approvals", "approved all network accesses for this command in parent Pi"],
    ],
  },
  {
    name: "command scopes prefer exact invocation and limit session denial",
    approval: {
      id: "command-scopes",
      kind: "command",
      target: "/nix/store/aaaaaaaa-tools/bin/deploy-hw",
      fields: {
        command: "/nix/store/aaaaaaaa-tools/bin/deploy-hw",
        scope_options: [
          {
            scope_kind: "command",
            scope_key: "command-executable:deploy-hw",
            scope_label: "/nix/store/aaaaaaaa-tools/bin/deploy-hw",
            scope_path: "/nix/store/aaaaaaaa-tools/bin/deploy-hw",
          },
          {
            scope_kind: "command-run",
            scope_key: "command-run:all-approvals",
            scope_label: "all requests for this command invocation",
            scope_lifetime: "command",
          },
          {
            scope_kind: "command",
            scope_key: "command-invocation:deploy-hw-pdi",
            scope_label: "deploy-hw image.pdi",
            scope_path: "/nix/store/aaaaaaaa-tools/bin/deploy-hw",
          },
        ],
      },
    },
    expected: [
      ["Deny once", "deny", "once", null, null, "denied in parent Pi"],
      ["Allow once", "approve", "once", null, null, "approved in parent Pi"],
      ["Allow all requests for this command invocation", "approve", "once", "command-run", "command-run:all-approvals", "approved all requests for this command invocation in parent Pi"],
      ["Allow this exact invocation for session", "approve", "session", "command", "command-invocation:deploy-hw-pdi", "approved for session command: deploy-hw image.pdi in parent Pi"],
      ["Allow any deploy-hw invocation for session", "approve", "session", "command", "command-executable:deploy-hw", "approved for session command: /nix/store/aaaaaaaa-tools/bin/deploy-hw in parent Pi"],
      ["Deny this exact invocation for session", "deny", "session", "command", "command-invocation:deploy-hw-pdi", "denied for session command: deploy-hw image.pdi in parent Pi"],
    ],
  },
  {
    name: "file scopes omit session denials and format directory breadth",
    approval: {
      id: "file-scopes",
      kind: "file",
      fields: {
        scope_options: [
          { scope_kind: "file", scope_key: "file:/workspace/src/file.ts", scope_path: "/workspace/src/file.ts" },
          { scope_kind: "file-dir", scope_key: "file-dir:/workspace/src", scope_path: "/workspace/src/" },
          { scope_kind: "file-tree", scope_key: "file-tree:/", scope_path: "/" },
        ],
      },
    },
    expected: [
      ["Deny once", "deny", "once", null, null, "denied in parent Pi"],
      ["Allow once", "approve", "once", null, null, "approved in parent Pi"],
      ["Allow this file for session", "approve", "session", "file", "file:/workspace/src/file.ts", "approved for session file: file:/workspace/src/file.ts in parent Pi"],
      ["Allow /workspace/src/* for session (one level)", "approve", "session", "file-dir", "file-dir:/workspace/src", "approved for session file-dir: file-dir:/workspace/src in parent Pi"],
      ["Allow /** for session", "approve", "session", "file-tree", "file-tree:/", "approved for session file-tree: file-tree:/ in parent Pi"],
    ],
  },
];

for (const testCase of choiceCases) {
  assert.deepEqual(choiceRows(approvalChoices(testCase.approval)), testCase.expected, testCase.name);
}

const selectedChoices: ApprovalChoice[] = [
  { label: "Deny once", decision: "deny", scope: "once", reason: "denied in parent Pi" },
  {
    label: "Allow exact",
    decision: "approve",
    scope: "session",
    reason: "approved exact scope",
    scope_kind: "command",
    scope_key: "command-invocation:exact",
  },
];

const resolutionCases: Array<{
  name: string;
  choice: string | undefined;
  expected: ApprovalResolution;
  selectedIndex?: number;
}> = [
  {
    name: "selected choice",
    choice: "Allow exact",
    expected: selectedChoices[1],
    selectedIndex: 1,
  },
  {
    name: "unknown choice fails closed",
    choice: "not offered",
    expected: { decision: "deny", scope: "once", reason: "denied in parent Pi" },
  },
  {
    name: "cancelled choice fails closed",
    choice: undefined,
    expected: { decision: "deny", scope: "once", reason: "denied in parent Pi" },
  },
];

for (const testCase of resolutionCases) {
  const resolution = resolveChoice(selectedChoices, testCase.choice);
  assert.deepEqual(resolution, testCase.expected, testCase.name);
  if (testCase.selectedIndex !== undefined) {
    assert.equal(resolution, selectedChoices[testCase.selectedIndex], `${testCase.name} should retain the selected resolution`);
  }
}

const bodyCases: Array<{
  name: string;
  resolution: ApprovalResolution;
  expected: ReturnType<typeof approvalResolutionBody>;
}> = [
  {
    name: "approval defaults",
    resolution: { decision: "approve" },
    expected: {
      decision: "approve",
      scope: "once",
      reason: "approved in parent Pi",
      scope_kind: undefined,
      scope_key: undefined,
      scope_label: undefined,
      scope_operation: undefined,
      scope_path: undefined,
      scope_rule: undefined,
      scope_prefix: undefined,
    },
  },
  {
    name: "denial default remains unchanged",
    resolution: { decision: "deny" },
    expected: {
      decision: "deny",
      scope: "once",
      reason: "denyd in parent Pi",
      scope_kind: undefined,
      scope_key: undefined,
      scope_label: undefined,
      scope_operation: undefined,
      scope_path: undefined,
      scope_rule: undefined,
      scope_prefix: undefined,
    },
  },
  {
    name: "scoped metadata is relayed exactly",
    resolution: {
      decision: "deny",
      scope: "session",
      reason: "operator denied exact scope",
      scope_kind: "file-dir",
      scope_key: "file-dir:read:/workspace/src",
      scope_label: "read one directory level",
      scope_operation: "read",
      scope_path: "/workspace/src",
      scope_rule: "outside-workspace-read",
      scope_prefix: false,
    },
    expected: {
      decision: "deny",
      scope: "session",
      reason: "operator denied exact scope",
      scope_kind: "file-dir",
      scope_key: "file-dir:read:/workspace/src",
      scope_label: "read one directory level",
      scope_operation: "read",
      scope_path: "/workspace/src",
      scope_rule: "outside-workspace-read",
      scope_prefix: false,
    },
  },
];

for (const testCase of bodyCases) {
  assert.deepEqual(approvalResolutionBody(testCase.resolution), testCase.expected, testCase.name);
}

console.log("sandbox approval model checks passed");
