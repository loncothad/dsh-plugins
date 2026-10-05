/** Dedicated protocol schemas expose documented options without pretending to know provider-only defaults. */
import type { MediaSchema } from '@loncothad/dsh-media-gen'
export function audioSchema(protocol: 'speech' | 'transcription', voices: unknown): MediaSchema {
  const supported = Array.isArray(voices)
    ? voices
        .filter((voice): voice is string => typeof voice === 'string' && voice.length > 0)
        .slice(0, 1024)
    : []
  return {
    type: 'object',
    additionalProperties: false,
    properties:
      protocol === 'speech'
        ? {
            model: { type: 'string' },
            input: { type: 'string', minLength: 1 },
            voice: {
              type: 'string',
              ...(supported.length ? { enum: supported } : {}),
              description:
                'Provider voice ID. Required unless the provider advertises a default voice.',
            },
            response_format: { type: 'string', enum: ['mp3', 'pcm'], default: 'mp3' },
            speed: {
              type: 'number',
              exclusiveMinimum: 0,
              description: 'Only set when the selected model supports speed control.',
            },
            provider_options: {
              type: 'object',
              additionalProperties: { type: 'object' },
              description:
                'Provider-specific passthrough options keyed by endpoint tag. Routing and privacy remain controlled by the provider settings.',
            },
          }
        : {
            model: { type: 'string' },
            input_audio: { type: 'object' },
            language: {
              type: 'string',
              pattern: '^[a-z]{2}$',
              description: 'ISO 639-1 language; omitted means auto-detect.',
            },
            temperature: { type: 'number', minimum: 0, maximum: 1 },
            response_format: { type: 'string', enum: ['json', 'verbose_json'], default: 'json' },
            timestamp_granularities: {
              type: 'array',
              maxItems: 2,
              uniqueItems: true,
              items: { type: 'string', enum: ['word', 'segment'] },
            },
            provider_options: {
              type: 'object',
              additionalProperties: { type: 'object' },
              description:
                'Provider-specific transcription options keyed by endpoint tag. This protocol cannot enforce per-request routing or privacy constraints.',
            },
          },
  }
}
