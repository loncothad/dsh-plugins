# Nix Package Skills

Load skills from configured roots and read their `metadata.nix-packages` declarations. Package-declaring skills receive the configured Nix shell instruction.

Set roots and the wrapper template in Plugins. The default is `nix shell {packages} -c {command}`. Requires Nix on the execution host.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/skill-nix-packages.md).
