# Fallback Router reference

In **Plugins > Fallback Router**, choose a primary provider/model and its fallback models in order. A primary can match every model in one provider. Each fallback can set a reasoning effort.

Fallback failure codes advance the chain. Retry codes retry the current route with bounded backoff. State belongs to one agent and turn; agents do not spend each other's retry allowance. Cancelling a turn or replacing configuration cancels pending delays.

A model fallback changes the actual request route. It does not silently change OpenRouter's upstream or privacy constraints. The next turn starts from the conversation's selected model.
