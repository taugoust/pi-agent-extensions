# A module-unit scaffold only. Real Home Manager integration is checked by the
# consumer's host contracts; this does not fake any Pi settings implementation.
{ self, pkgs }:
let
  inherit (pkgs) lib;
  evaluate =
    pi:
    (lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        (import ./module.nix { inherit self; })
        {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.anything;
              default = [ ];
            };
            home = {
              homeDirectory = lib.mkOption {
                type = lib.types.str;
                default = "/fixture-home";
              };
              file = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
              };
              packages = lib.mkOption {
                type = lib.types.listOf lib.types.package;
                default = [ ];
              };
              sessionVariables = lib.mkOption {
                type = lib.types.attrsOf lib.types.str;
                default = { };
              };
              activation = lib.mkOption {
                type = lib.types.attrsOf lib.types.anything;
                default = { };
              };
            };
          };
          config.programs.pi = {
            enable = true;
            package = null;
          }
          // pi;
        }
      ];
    }).config;
  valid =
    config:
    let
      booleans = map (entry: entry.assertion) config.assertions;
    in
    builtins.deepSeq booleans (lib.all (value: value) booleans);
in
{
  inherit evaluate valid;
}
