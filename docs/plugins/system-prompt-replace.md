# System Prompt Replace reference

Replaces dsh's system prompt wholesale: a section registered with `complete: true` is restored by the system-prompt seam as the **sole** section: harness identity, persona, and first-party guidance drop; tools, contexts, and variables still resolve through the assembly waterfall.

Exactly one source: `prompt` (inline) or `file` (read at registration; a reload re-resolves). `{{variable}}` interpolation stays available (strict) unless `interpolate: false`; `suppressRuntimeContext: true` also drops runtime-context snapshots. `/system-prompt` shows the active replacement.

Mutually exclusive with `system-prompt-agents-switch` (a complete section wins over every other section).

```yaml
- insert:
    - id: system-prompt-replace
      name: @loncothad/dsh-system-prompt-replace
      config:
        file: "SUPERPROMPT.md"   # or prompt: "…"
```
