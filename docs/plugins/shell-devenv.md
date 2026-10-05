# Devenv Shell reference

Run shell commands in the nearest project with `devenv.nix` or `devenv.yaml`. Configure Auto, On or Off, the wrapper and limits in **Plugins > Devenv Shell**. Requires bash, Nix and devenv on a POSIX Harness host.

Install alongside Nix Flake Shell. The closest project wins; Devenv wins a tie. Wrappers do not nest. Shared shell limits use the stricter configured values. Native sandbox policy, working directory and cancellation still apply.
