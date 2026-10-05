# Devenv Shell

Run shell commands in the nearest project with `devenv.nix` or `devenv.yaml`. Configure Auto, On or Off, the wrapper and limits in Plugins.

Requires bash, Nix and devenv on a POSIX Harness host. With Nix Flake Shell installed, the closest project wins and Devenv wins a tie. Wrappers do not nest; native sandbox policy and cancellation still apply.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/shell-devenv.md).
