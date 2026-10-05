# Nix Flake Shell reference

Run shell commands inside the nearest `flake.nix` using `nix develop`. Configure Auto, On or Off, a named devShell, an optional flake root and Nix executable in Plugins. The command runs with the conversation working directory and native sandbox policy. Lock files are not written.

Install alongside Devenv Shell. The closest detected project wins; Devenv wins when both roots match. Wrappers do not nest. Common shell limits use the stricter configured values. Changing or disabling a matched rule cancels its running requests.

Requires bash and Nix on a POSIX Harness host. Windows hosts can run DSH in WSL.
