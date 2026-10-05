# Policy Engine reference

An independent execution decision layer using native DSH monotonic guards and human approvals. **Plugins → Policy Engine** configures Off/Observe/Enforce, fallback environment, default outcome, explicit tool-glob rules, evidence contracts, approval deadline and the optional structured-refusal/output-state skill. `/policy` inspects the active rules.

## Decision precedence

Deny dominates review; review dominates allow. Review defaults to native approval for the exact action hash, including tool arguments, immutable environment and evidence target. Missing approval support and expired/cancelled/rejected review deny. A final guard rechecks the decision after extensible pre-execution middleware; no prompt or later allow listener can override it. Native sandbox and other guard denials remain authoritative. Evidence Assurance supplies grounded verdicts; missing evidence cannot be waived by model text or this plugin’s approval.

## Rule design

Rules should allow low-impact inspection deliberately and require stronger contracts for consequential operations. Generic shell commands can perform many different actions, so broad shell allow rules weaken the boundary: classify or constrain execution through trusted consumers instead of relying on a prompt. Direct tool execution receives the same guard. Observe does not grant permission or override native restrictions. Configuration replacement disposes pending review authority before installing new rules.

## Full Access

**Honor Full Access** is enabled by default. DSH’s native Full Access preset authorizes unmatched default reviews, so ordinary writes and shell calls do not fail because that preset disables prompts. Explicit deny/review rules and evidence contracts remain enforced. Never by itself, Auto review and a full-access executor without the native preset do not grant this exception. Disable the setting to retain default reviews in Full Access. A review rule combined with Never returns a configuration conflict identifying the rule; switch to Ask or edit that rule instead of retrying.

## Remembered approvals

Policy prompts offer **Allow once** or **Approve similar**. Similar approvals are scoped to the current chat, workspace, environment, sandbox mode and policy version, expire after the configured lifetime, and can be revoked under **Session tools → Policy permissions**. Only literal workspace directory listings share a family; other actions match exact arguments. Explicit denials, evidence contracts and native sandbox limits remain authoritative. Native **Never** rejects actions that still require review. Goal planning and progress tools are allowed by the default policy; custom rules remain authoritative.
