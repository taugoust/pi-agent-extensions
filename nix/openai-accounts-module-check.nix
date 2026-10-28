{ self, pkgs }:
let
  inherit (pkgs) lib;
  inherit (import ./module-test-harness.nix { inherit self pkgs; }) evaluate valid;
  make =
    accounts: usage:
    evaluate {
      agentDir = ".config/fixture-pi";
      extensions.accounts.enable = accounts;
      extensions.usage.enable = usage;
    };
  both = make true true;
  accountsOnly = make true false;
  usageOnly = make false true;
  neither = make false false;
  files = config: config.home.file;
  root = ".config/fixture-pi";
  accountPath = "${root}/extensions/openai-accounts";
  usagePath = "${root}/extensions/openai-usage";
  registry = import ./extension-registry.nix { inherit self; };
in
# Package and module selections share the same compatibility dependency closure.
assert lib.elem "openai-accounts" (registry.resolveExtensions [ "openai-usage" ]);
assert !(lib.elem "openai-usage" (registry.resolveExtensions [ "openai-accounts" ]));
assert lib.all valid [
  both
  accountsOnly
  usageOnly
  neither
];
assert lib.all (config: (files config) ? ${"${root}/extensions/shared"}) [
  both
  accountsOnly
  usageOnly
];
assert (files both) ? ${accountPath} && (files both) ? ${usagePath};
assert (files accountsOnly) ? ${accountPath} && !((files accountsOnly) ? ${usagePath});
# The legacy usage option now installs the account UI, without a /usage command.
assert (files usageOnly) ? ${usagePath} && (files usageOnly) ? ${accountPath};
assert !((files neither) ? ${accountPath}) && !((files neither) ? ${usagePath});
# Enabling account controls must never declare credentials or an account store,
# nor silently take over the user's native settings/models files.
assert lib.all
  (
    config:
    lib.all (name: name == "${root}" || lib.hasPrefix "${root}/" name) (
      builtins.attrNames (files config)
    )
    && lib.all (name: !((files config) ? ${"${root}/${name}"})) [
      "auth.json"
      "oauth.json"
      "accounts.json"
      "pi-accounts.json"
      "pi-codex-accounts.json"
      "codex-accounts.json"
      "settings.json"
      "models.json"
    ]
    && config.home.sessionVariables.PI_CODING_AGENT_DIR == "/fixture-home/${root}"
  )
  [
    both
    accountsOnly
    usageOnly
    neither
  ];
pkgs.runCommand "openai-accounts-module-contract" { } ''
  test -f ${(files both).${accountPath}.source}/index.ts
  test -f ${(files both).${usagePath}.source}/index.ts
  test -f ${(files both).${"${root}/extensions/shared"}.source}/account-controls.ts
  test -f ${(files both).${accountPath}.source}/node_modules/proper-lockfile/package.json
  test -f ${(files both).${accountPath}.source}/node_modules/proper-lockfile/LICENSE
  printf '%s\n' 'opt-in composition, canonical aliases, agentDir and credential non-ownership verified' > "$out"
''
