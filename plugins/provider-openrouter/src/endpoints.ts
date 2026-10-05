/** Public endpoint metadata. Missing observations stay unknown; status is not uptime or retention. */
import { publicJson } from './public-json.ts'
export interface Endpoint {
  tag: string
  name: string
  provider: string
  inputPrice?: number
  outputPrice?: number
  latency?: number
  throughput?: number
  uptime?: number
  zeroRetention?: boolean
  prices: { field: string; rate: number; unit: string }[]
  observedAt: number
  tokenMetrics: boolean
  privacyUrl?: string
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined
const number = (value: unknown): number | undefined =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : undefined
const httpsUrl = (value: unknown): string | undefined => {
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined
  } catch {
    return undefined
  }
}

export function parseEndpoints(payload: unknown, providers?: unknown, zdr?: unknown): Endpoint[] {
  const data = record(record(payload).data),
    endpoints = data.endpoints
  const modalities = record(data.architecture).output_modalities
  const tokenMetrics =
    Array.isArray(modalities) &&
    modalities.includes('text') &&
    !modalities.some((value) => ['speech', 'transcription', 'video'].includes(String(value)))
  if (!Array.isArray(endpoints)) throw new Error('OpenRouter did not return an endpoint list')
  const policies = record(providers).data
  const zeroRetention = record(zdr).data
  const seen = new Set<string>()
  return endpoints.flatMap((value): Endpoint[] => {
    const row = record(value)
    const tag = text(row.tag)
    if (!tag || seen.has(tag)) return []
    seen.add(tag)
    const policy = Array.isArray(policies)
      ? record(policies.find((value) => record(value).slug === tag.split('/')[0]))
      : {}
    const price = record(row.pricing)
    const input = number(price.prompt)
    const output = number(price.completion)
    const latency = number(record(row.latency_last_30m).p50)
    const throughput = number(record(row.throughput_last_30m).p50)
    const uptime = number(row.uptime_last_1d)
    const privacyUrl = httpsUrl(policy.privacy_policy_url)
    return [
      {
        observedAt: Date.now(),
        tokenMetrics,
        prices: Object.entries(price).flatMap(([field, value]) => {
          const rate = number(value)
          if (rate === undefined || ['discount'].includes(field)) return []
          const token =
            tokenMetrics &&
            [
              'prompt',
              'completion',
              'input_cache_read',
              'input_cache_write',
              'internal_reasoning',
            ].includes(field)
          return [
            {
              field,
              rate: token ? rate * 1e6 : rate,
              unit: token
                ? 'USD / million tokens'
                : field === 'request'
                  ? 'USD / request'
                  : 'USD / billing unit unknown',
            },
          ]
        }),
        tag,
        name: text(row.name) ?? tag,
        provider: text(row.provider_name) ?? tag,
        ...(tokenMetrics && input !== undefined ? { inputPrice: input * 1e6 } : {}),
        ...(tokenMetrics && output !== undefined ? { outputPrice: output * 1e6 } : {}),
        ...(latency !== undefined ? { latency } : {}),
        ...(throughput !== undefined ? { throughput } : {}),
        ...(uptime !== undefined && uptime <= 100 ? { uptime } : {}),
        // A positive match is evidence of ZDR eligibility. Absence does not establish a retention period.
        ...(Array.isArray(zeroRetention) &&
        zeroRetention.some((value) => {
          const candidate = record(value)
          return candidate.tag === tag && candidate.model_id === row.model_id
        })
          ? { zeroRetention: true }
          : {}),
        ...(privacyUrl ? { privacyUrl } : {}),
      },
    ]
  })
}

/** No bearer tokens are sent from the browser. All these resources are public. */
export async function fetchEndpoints(
  model: string,
  signal?: AbortSignal,
  transport = fetch,
): Promise<Endpoint[]> {
  const segments = model.split('/')
  if (segments.length !== 2 || segments.some((part) => !part))
    throw new Error('Select a canonical author/model ID')
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000)
  const get = async (url: string) => {
    const response = await transport(url, {
      signal: requestSignal,
      credentials: 'omit',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`OpenRouter catalog request failed (HTTP ${response.status})`)
    return publicJson(response, requestSignal)
  }
  const [endpoints, providers, zdr] = await Promise.allSettled([
    get(
      `https://openrouter.ai/api/v1/models/${segments.map(encodeURIComponent).join('/')}/endpoints`,
    ),
    get('https://openrouter.ai/api/v1/providers'),
    get('https://openrouter.ai/api/v1/endpoints/zdr'),
  ])
  if (endpoints.status === 'rejected') throw endpoints.reason
  return parseEndpoints(
    endpoints.value,
    providers.status === 'fulfilled' ? providers.value : undefined,
    zdr.status === 'fulfilled' ? zdr.value : undefined,
  )
}
