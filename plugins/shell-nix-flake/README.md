# Nix Flake Shell

Run shell commands inside the nearest `flake.nix` with `nix develop`. Configure Auto, On or Off, a named devShell, an optional root and the Nix executable in Plugins. Lock files are not written.

Requires bash and Nix on a POSIX host; Windows can use WSL. With Devenv Shell installed, the closest project wins and Devenv wins a tie. Native sandbox policy and cancellation still apply.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/shell-nix-flake.md).
