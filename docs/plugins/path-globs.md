# Path Globs reference

`@loncothad/dsh-path-globs` expands file patterns in newly admitted human messages and provides `/glob preview PATTERN [PATTERN...]`. It adds a sorted file-list snapshot while retaining the exact original text, attachments and message identity. It never reads matched file contents or rewrites model tool arguments.

Configure it in **Plugins → Path Globs**. Patterns are relative to the session workspace. The default project boundary is the closest Git root; workspace and explicit root modes are also available. **Honor project ignore files** enables or bypasses all project ignore-file reads. `.gitignore` and `.ignore` also have independent toggles; both are enabled by default.

## Ignore files

**Additional ignore files** accepts up to 32 plain filenames, one per line, such as `.dshignore` and `.customignore`. Use Git ignore syntax in each file. Files load at the project root and, when **Read ignore files in child directories** is enabled, relative to their own child directory. The same-directory order is `.gitignore`, `.ignore`, then your additional names in configured order. Later rules can negate earlier file exclusions; excluded parent directories are not scanned. Missing ignore files are skipped; unsafe or oversized files fail explicitly. Duplicate names are read once. Paths, wildcards, reserved names and the built-in names are rejected (use the dedicated built-in toggles instead).

**Additional exclusions** are explicit rules that can only remove files and still apply with ignore-file honoring disabled. Dot-file matching and case sensitivity are configurable. Symlinks and `.git` metadata are excluded. `/glob status` reports the current ignore configuration; preview and automatic message expansion use it consistently.

## Patterns and limits

Bare paths, inline backticks, quoted paths and `@path` references are supported. Fenced code examples are skipped by default. URL patterns and parent traversal are rejected. Preview and automatic admission use the same fresh enumeration and rules.

Limits bound patterns, matches, visited entries, directory depth, ignore bytes, result bytes and time. An overflow fails explicitly rather than returning a partial list. Zero matches produces an explicit empty list. Scans are cancelled when the turn or plugin generation ends. Directory-containment checks do not replace the host's OS sandbox.

The compact **Session tools → Glob preview** panel previews and copies all matched paths. Its list is paginated for display; model admission includes the complete bounded result. No API key or model call is required.
