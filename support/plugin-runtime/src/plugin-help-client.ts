/** Short, task-specific help shown on the native Plugins page. */
export const pluginHelp: Record<string, string> = {
  'heads-up':
    'Watch main-agent and subagent work for overlooked risks. Notices stay private until you choose Discuss in chat. Local checks need no API; independent model review is optional.',
  'command-model-links':
    'Link equivalent provider/model routes, then use /model-cycle to switch this conversation. Configure automatic recovery in Fallback Router.',
  'fallback-router':
    'Choose a primary model and an ordered fallback list. A matching failure switches to the next route; a new turn starts from its selected model.',
  'provider-cloudflare-decisions':
    'Configure Clef and Clef Flash on Workers AI. In Decision Models, select Cloudflare for commands, tools and automatic summary decisions. Embedded images are optional.',
  'llm-decision-models':
    'Choose from a fixed set with decision.ask or /decision. Use this for routing, classification or summary triggers. A model decision does not grant permission or prove completion.',
  'web-search':
    'Choose a search provider for each web search request. Configure each provider below. Codex uses a signed-in subscription account; OpenAI API uses its own paid API key.',
  'system-prompt-agents-switch':
    'Append a different instruction file for each provider/model. Paths are relative to the conversation workspace. /agents-file status shows its mapping; /agents-file PATH changes it.',
  'shell-devenv':
    'Run shell commands inside the nearest devenv project. Auto detects devenv.nix or devenv.yaml. Requires bash, Nix and devenv on the Harness host.',
  'shell-nix-flake':
    'Run shell commands with nix develop inside the nearest flake project. Choose its devShell output below. Requires bash and Nix with flakes enabled on the Harness host.',
  'system-prompt-replace':
    'Replace the assembled system prompt with your text. Save to apply it to future requests. /system-prompt shows whether the override is active.',
  'skill-nix-packages':
    'Load skills from selected Nix package paths. /nix-skills lists the active skills. The Harness host needs Nix.',
  'provider-openai-codex':
    'Use a ChatGPT Codex subscription account. Sign in below, choose the active account and configure account fallback. /codex-usage clears local observations. Account quota cards show remaining allowance and available subscription resets.',
  'provider-openrouter':
    'Use OpenRouter for chat and media. Per-model upstream selections override the global routing preference. Privacy requirements also apply to media.',
  'provider-fal':
    'Discover fal models, choose task defaults and edit their parameters. Enable only the tools, commands and skills you need. Generation uses your fal balance.',
  'provider-zai':
    'Use a Z.AI API key or sign in with ZCode. Account credentials stay on the Harness host.',
  'plan-goals':
    'Review a goal and its completion criteria before starting. Regular goals can adapt their tasks; Sisyphus follows the approved step order. Pause, revise and resume from the session panel.',
  'conversation-summary':
    'Show progress since the last summary in a private card. External summaries stay outside the main model context and compaction. Configure automatic triggers below.',
  'evidence-compactor':
    'Replace standard and PTC compaction with source-linked memory. Original evidence stays recoverable. Optional extraction uses the selected provider and model.',
  'policy-engine':
    'Decide whether an action may run before dispatch. Rules are evaluated outside model prompts. /policy shows the current decision rules.',
  'environment-isolation':
    'Keep dev, staging and prod settings and data in separate host homes. /environment shows the active environment and resolved limits.',
  'secrets-broker':
    'Give tools scoped credentials at execution time. Raw values stay on the host. Configure Vault, 1Password, Linux Secret Service or Windows SecretManagement references.',
  'execution-recovery':
    'Track leased plugin jobs, retries and dead letters. /runs lists jobs, inspects failures and retries eligible work.',
  'evidence-assurance':
    'Require sources, fresh reads or a verifier before consequential actions and completion. /assurance inspects evidence; /workflow edits completion criteria.',
  'workspace-safety':
    'Start work in an isolated Git worktree. Store checkpoints outside the repository, then create, diff or restore them with /checkpoint.',
  'context-inspector':
    'Inspect the actual main-agent request and its estimated context use. Open Context inspector from Session tools; private summaries remain separate.',
  'path-globs':
    'Expand file globs in user messages or preview with /glob preview. Choose the project root and ignore files below. Matching file contents are not read.',
}
