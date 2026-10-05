# Decision Models reference

Use fixed-choice decisions for routing, classification or summary delivery. Configure the backend in **Plugins > Decision Models**:

- OpenRouter Decisions uses credentials from the OpenRouter plugin and `/api/alpha/decisions`.
- Cloudflare uses the Cloudflare Decisions plugin. Configure its account, token, default model and vision toggle there.
- TypeSafe calls the native System One API.
- A registered text model can choose named answers. It does not report calibrated probabilities.

`decision.ask` chooses one allowed answer. `decision.evaluate` handles named choice, ordered score and yes/no questions. `/decision Question :: choice | choice :: state` tests a choice; `/decision JSON` accepts `{state,questions}`. `/decision status` shows the active backend.

Native probabilities are provider-reported model output. Results remain `unverified` and never replace permissions or completion evidence. Requests have bounded input, response, time and concurrency. Disabling the backend blocks direct calls too. Conversation Summaries can select this backend for automatic delivery decisions.

Protocol references: [TypeSafe](https://docs.typesafe.ai/api), [Cloudflare](https://developers.cloudflare.com/workers-ai/models/clef/), [OpenRouter](https://openrouter.ai/blog/insights/what-is-jev/).
