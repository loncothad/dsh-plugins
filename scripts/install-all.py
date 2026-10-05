"""Install every dsh-plugins package into a dsh profile as real packages.

Profile-installed plugins get the full native surface: display metadata
(locale/en.json titles and descriptions), the Plugins tab inventory,
Settings namespaces, and client-module (browser half) support — none of
which activate for path-loaded overlay rows.

Usage:  python scripts/install_all.py [--profile web] [--owner-dir ..]
Run from the vendored harness checkout or anywhere; requires the dsh CLI
(node --import tsx/esm apps/cli/src/bin.ts plugin …).
"""
import io
import os
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HARNESS = os.path.join(os.path.dirname(ROOT), "external", "deepseek-harness")
DSH = ["node", "--import", "tsx/esm", os.path.join("apps", "cli", "src", "bin.ts")]

args = sys.argv[1:]
PROFILE = "web"
if "--profile" in args:
    PROFILE = args[args.index("--profile") + 1]

ORDER = [
    "support/openai-wire",
    "support/llm-openai-compat",
    "support/media-gen",
    "plugins/provider-openai-codex",
    "plugins/provider-zai",
    "plugins/provider-openrouter",
    "plugins/llm-decision-models",
    "plugins/provider-fal",
    "plugins/web-search",
    "plugins/fallback-router",
    "plugins/command-model-links",
    "plugins/command-usage-reset",
    "plugins/skill-nix-packages",
    "plugins/shell-devenv",
    "plugins/system-prompt-agents-switch",
    "plugins/system-prompt-replace",
]

for rel in ORDER:
    path = os.path.join(ROOT, rel.replace("/", os.sep))
    print(f"installing {rel} …", flush=True)
    result = subprocess.run(
        DSH + ["plugin", "--profile", PROFILE, "add", path],
        cwd=HARNESS,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stdout)
        print(result.stderr)
        sys.exit(f"failed to install {rel}")
print(f"installed {len(ORDER)} packages into profile '{PROFILE}'")
