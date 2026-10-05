import type { MediaCatalogModel, MediaParameter, MediaSchema } from '@loncothad/dsh-media-gen'
export function parseVideoModels(payload: unknown): MediaCatalogModel[] {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { data?: unknown }).data)
  )
    throw new Error('Invalid OpenRouter video catalog')
  const models: MediaCatalogModel[] = []
  for (const value of (payload as { data: unknown[] }).data) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id) continue
    if (
      ![
        'supported_durations',
        'supported_resolutions',
        'supported_aspect_ratios',
        'supported_frame_images',
        'allowed_passthrough_parameters',
        'pricing_skus',
      ].some((key) => Object.hasOwn(row, key))
    )
      continue
    const parameters: Record<string, MediaParameter> = {}
    for (const [field, source, type] of [
      ['duration', 'supported_durations', 'number'],
      ['resolution', 'supported_resolutions', 'string'],
      ['aspect_ratio', 'supported_aspect_ratios', 'string'],
      ['size', 'supported_sizes', 'string'],
    ] as const) {
      const values = Array.isArray(row[source])
        ? (row[source] as unknown[]).filter(
            (value): value is string | number =>
              typeof value === type && (typeof value !== 'number' || Number.isFinite(value)),
          )
        : []
      if (values.length) parameters[field] = { type, values }
    }
    for (const field of ['generate_audio', 'seed'])
      if (row[field] === true) parameters[field] = { type: field === 'seed' ? 'number' : 'boolean' }
    const pricing =
      row.pricing_skus && typeof row.pricing_skus === 'object'
        ? Object.entries(row.pricing_skus)
            .filter(
              ([, value]) =>
                typeof value === 'string' && Number.isFinite(Number(value)) && Number(value) >= 0,
            )
            .map(([key, value]) => `${key}: $${value}`)
            .join(' · ')
        : ''
    const inputSchema: MediaSchema = {
      type: 'object',
      required: ['model', 'prompt'],
      additionalProperties: false,
      properties: {
        model: { type: 'string' },
        prompt: { type: 'string', minLength: 1 },
        ...Object.fromEntries(
          Object.entries(parameters).map(([name, value]) => [
            name,
            {
              type: name === 'duration' ? 'integer' : value.type,
              ...(value.values ? { enum: value.values } : {}),
            },
          ]),
        ),
        seed: { type: 'integer' },
        generate_audio: { type: 'boolean' },
        frame_images: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            required: ['type', 'image_url', 'frame_type'],
            additionalProperties: false,
            properties: {
              type: { const: 'image_url' },
              image_url: {
                type: 'object',
                required: ['url'],
                additionalProperties: false,
                properties: { url: { type: 'string' } },
              },
              frame_type: { type: 'string', enum: ['first_frame', 'last_frame'] },
            },
          },
        },
        input_references: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            required: ['type', 'image_url'],
            additionalProperties: false,
            properties: {
              type: { const: 'image_url' },
              image_url: {
                type: 'object',
                required: ['url'],
                additionalProperties: false,
                properties: { url: { type: 'string' } },
              },
            },
          },
        },
        provider_options: {
          type: 'object',
          additionalProperties: { type: 'object' },
          description:
            'Provider passthrough options keyed by endpoint tag. DSH polls this job; callbacks and streaming are unsupported.',
        },
      },
    }
    models.push({
      inputSchema,
      id: row.id,
      name: typeof row.name === 'string' ? row.name : row.id,
      outputs: ['video'],
      protocol: 'video',
      fetchedAt: Date.now(),
      inputs:
        Array.isArray(row.supported_frame_images) && row.supported_frame_images.length
          ? ['text', 'image']
          : ['text'],
      parameters,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(pricing ? { pricing } : {}),
    })
  }
  return models
}
