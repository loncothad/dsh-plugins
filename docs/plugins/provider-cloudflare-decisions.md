# Cloudflare Decisions reference

Configure a Cloudflare account ID and Workers AI token in Plugins. Choose Clef or Clef Flash as the default; then select Cloudflare in Decision Models for `/decision`, tools and summary delivery decisions. Both models use typed choice, score and yes/no questions, structured instructions and optional embedded images.

## Vision limits

Vision accepts PNG, JPEG and WebP data URLs or `{content_type,base64}` objects. Limits: four images, 4 MiB and 16 megapixels each, 8 MiB total, 13 MiB request. Remote image URLs are rejected. Sampled video frames can be supplied as images; there is no separate video upload endpoint in the advertised contract.

Disable the provider or vision independently. Timeout and concurrency limits apply to direct calls too. Credentials stay on the host. Model probabilities stay unverified and cannot authorize an action.

Contracts and current model metadata: [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [release announcement](https://blog.cloudflare.com/clef-decision-models/).
