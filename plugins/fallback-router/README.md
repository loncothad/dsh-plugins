# Fallback Router

Choose a primary route or provider wildcard, then an ordered list of fallback models and reasoning efforts in **Plugins > Fallback Router**.

Configure which errors advance to the next model and which retry the current one. Retries are bounded. Fallback changes only the failed turn's route; later turns use the selected model. OpenRouter privacy settings still apply.

[Install](https://github.com/loncothad/dsh-plugins/blob/main/docs/installation.md) · [Configuration and commands](https://github.com/loncothad/dsh-plugins/blob/main/docs/plugins/fallback-router.md).
