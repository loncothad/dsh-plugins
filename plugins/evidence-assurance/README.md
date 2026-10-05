# Evidence Assurance

Define completion criteria and evidence requirements: independent sources, fresh reads, deterministic checks, a separate verifier model or human review.

Configure contracts in Plugins. Start with `/workflow start CONTRACT :: CRITERIA`, inspect with `/assurance status`, verify with `/assurance verify CONTRACT`, and finish with `/workflow complete`.

Receipts are tied to the current workspace and criteria. A model's verdict alone is not proof. Contracts also gate model-driven goal completion when Plan & Goals is installed.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/evidence-assurance.md).
