/** Installed-artifact video/3D qualification. Catalog prices must permit a conservative reservation. */

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { QualificationBudget, qualificationDirectory } from './budget.mjs'

const consumerArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
if (!consumerArg)
  throw Error('Usage: node tests/live/video-3d.mjs INSTALLED_CONSUMER [--video-only]')
const consumer = resolve(consumerArg),
  directory = resolve('.qualification/extended-media')
const require = createRequire(join(consumer, 'package.json')),
  load = async (name) => import(pathToFileURL(require.resolve(name)).href)
const { OpenRouterMediaGenerator } = await load('@loncothad/dsh-provider-openrouter')
const { parseVideoModels } = await import(
  pathToFileURL(
    join(
      dirname(require.resolve('@loncothad/dsh-provider-openrouter/package.json')),
      'lib/video-catalog.js',
    ),
  ).href
)
const { FalCatalog, FalGenerator } = await load('@loncothad/dsh-provider-fal')
const { runMediaGeneration, readMediaResponse } = await load('@loncothad/dsh-media-gen')
const budget = await QualificationBudget.open(qualificationDirectory())
const results = []
async function json(url, key) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: key ? { authorization: `Key ${key}` } : {},
  })
  if (!response.ok) throw new Error(`Provider metadata failed (HTTP ${response.status})`)
  return response.json()
}
async function attempt(operation, reservation, run) {
  const row = await budget.reserve(operation, reservation)
  const start = performance.now()
  try {
    const result = await run()
    const value = {
      operation,
      latencyMs: performance.now() - start,
      files: result.files,
      text: result.text ?? null,
      billedUsage: result.raw?.usage ?? null,
    }
    await budget.complete(row, value)
    results.push(value)
    console.log(`${operation}: passed`)
  } catch (error) {
    let message = String(error)
    for (const key of [process.env.FAL_KEY, process.env.OPENROUTER_API_KEY])
      if (key) message = message.replaceAll(key, '[redacted]')
    const value = { operation, error: message, charge: 'unknown; reservation retained' }
    await budget.complete(row, value)
    results.push(value)
    console.log(`${operation}: did not qualify`)
  }
}
try {
  const video = await json('https://openrouter.ai/api/v1/videos/models')
  const quotes = video.data
    .flatMap((row) => {
      if (
        !row.pricing_skus ||
        Object.keys(row.pricing_skus).some(
          (key) => !key.startsWith('per-video-second') && !key.startsWith('duration_seconds'),
        )
      )
        return []
      const rates = Object.values(row.pricing_skus).map(Number),
        duration = Math.min(
          ...(row.supported_durations ?? []).filter((n) => Number.isInteger(n) && n > 0),
        )
      if (
        !rates.length ||
        rates.some((n) => !Number.isFinite(n) || n <= 0) ||
        !Number.isFinite(duration) ||
        duration > 10
      )
        return []
      return [{ row, duration, reserved: Math.max(...rates) * duration * 2 + 0.1 }]
    })
    .filter((quote) => quote.reserved <= 5)
    .sort((a, b) => a.reserved - b.reserved)
  const quote = quotes[0]
  if (quote) {
    const model = parseVideoModels({ data: [quote.row] })[0]
    const operation = process.env.DSH_VIDEO_QUALIFICATION_ID ?? 'openrouter-asynchronous-video'
    if (!/^[a-z0-9-]{1,64}$/.test(operation)) throw new Error('Invalid video qualification ID')
    await attempt(operation, quote.reserved, () =>
      runMediaGeneration(
        {
          generator: new OpenRouterMediaGenerator({
            endpoint: 'https://openrouter.ai/api/v1/chat/completions',
            videoEndpoint: 'https://openrouter.ai/api/v1/videos',
            apiKey: () => process.env.OPENROUTER_API_KEY,
            maxResponseBytes: 33554432,
            videoPollMs: 30000,
            fetch: async (url, init) => {
              const response = await fetch(url, init)
              if (init?.method === 'POST' && response.ok) {
                const submitted = JSON.parse(
                  new TextDecoder().decode(
                    await readMediaResponse(response.clone(), 2097152, init.signal),
                  ),
                )
                await mkdir(directory, { recursive: true })
                await writeFile(
                  join(directory, `${operation}-submitted.json`),
                  `${JSON.stringify({ operation, model: model.id, submitted }, null, 2)}\n`,
                )
              }
              return response
            },
          }),
          outDir: directory,
          maxOutputBytes: 33554432,
        },
        {
          model: model.id,
          protocol: 'video',
          inputSchema: model.inputSchema,
          output: 'video',
          prompt: 'A blue ceramic cup on a plain white table. Static camera.',
          options: {
            duration: quote.duration,
            ...(model.parameters?.resolution?.values?.length
              ? { resolution: model.parameters.resolution.values[0] }
              : {}),
            generate_audio: false,
          },
        },
        AbortSignal.timeout(600000),
      ),
    )
  } else
    results.push({
      operation: 'openrouter-asynchronous-video',
      skipped: 'No complete bounded per-second price quote within the operation limit',
    })
  if (process.argv.includes('--video-only')) {
    console.log('Video-only qualification finished')
  } else {
    const source = process.env.DSH_FAL_3D_IMAGE
    if (!source) throw new Error('Set DSH_FAL_3D_IMAGE to an explicit test image path or URL')
    const catalog = new FalCatalog({ apiKey: () => process.env.FAL_KEY })
    const candidates = (await catalog.models(AbortSignal.timeout(60000)))
      .filter((model) => model.outputs.includes('3d') && model.inputs?.includes('image'))
      .slice(0, 12)
    let chosen
    for (const entry of candidates) {
      const payload = await json(
        `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(entry.id)}`,
        process.env.FAL_KEY,
      )
      const p = payload.prices?.find((price) => price.endpoint_id === entry.id)
      if (
        p?.currency === 'USD' &&
        p.unit_price > 0 &&
        p.unit_price <= 1 &&
        [
          'image',
          'images',
          'request',
          'requests',
          'generation',
          'generations',
          'inference',
        ].includes(p.unit)
      ) {
        const model = await catalog.describe(entry.id)
        if (model.inputSchema && !model.unavailableReason) {
          chosen = { model, p }
          break
        }
      }
    }
    if (chosen)
      await attempt('fal-three-dimensional-output', Math.max(2, chosen.p.unit_price * 4), () =>
        runMediaGeneration(
          {
            generator: new FalGenerator({
              apiKey: () => process.env.FAL_KEY,
              execution: { '3d': 'queue' },
            }),
            outDir: directory,
            maxOutputBytes: 67108864,
            maxFiles: 16,
          },
          {
            model: chosen.model.id,
            protocol: 'fal',
            inputSchema: chosen.model.inputSchema,
            outputSchema: chosen.model.outputSchema,
            output: '3d',
            prompt: '',
            inputs: [{ kind: 'image', url: source }],
          },
          AbortSignal.timeout(240000),
        ),
      )
    else
      results.push({
        operation: 'fal-three-dimensional-output',
        skipped:
          'No complete usable schema and bounded price quote in the inspected advertised candidates',
      })
  }
} finally {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${process.env.DSH_VIDEO_QUALIFICATION_ID ?? 'qualification'}.json`),
    `${JSON.stringify({ results, reservedUsd: budget.reservedUsd }, null, 2)}\n`,
  )
  await budget.close()
  console.log(JSON.stringify({ results, reservedUsd: budget.reservedUsd }, null, 2))
}
