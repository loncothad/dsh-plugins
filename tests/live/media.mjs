/** Paid media qualification uses installed artifacts and shares the durable $25 ledger. */

import { readdir, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseFile } from 'music-metadata'
import { QualificationBudget, qualificationDirectory } from './budget.mjs'

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (!positional[0] || !positional[1])
  throw Error(
    'Usage: node tests/live/media.mjs INSTALLED_CONSUMER OUTPUT_DIRECTORY [--recover-speech]',
  )
const consumer = resolve(positional[0]),
  directory = resolve(positional[1])
const require = createRequire(join(consumer, 'package.json'))
const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
const { OpenRouterMediaGenerator, parseModelsResponse } = await load(
  '@loncothad/dsh-provider-openrouter',
)
const { runMediaGeneration } = await load('@loncothad/dsh-media-gen')
if (positional.length > 2)
  throw new Error(
    'Set the shared DSH_QUALIFICATION_BUDGET_DIR instead of passing a separate budget',
  )
const budget = await QualificationBudget.open(qualificationDirectory())
const results = []
async function models(protocol) {
  const response = await fetch(
    `https://openrouter.ai/api/v1/models?output_modalities=${protocol}`,
    { signal: AbortSignal.timeout(15000) },
  )
  if (!response.ok) throw new Error('Media metadata unavailable')
  return response.json()
}
const generator = new OpenRouterMediaGenerator({
  endpoint: 'https://openrouter.ai/api/v1/chat/completions',
  apiKey: () => process.env.OPENROUTER_API_KEY,
  maxResponseBytes: 8388608,
})
try {
  const raw = await models('speech')
  const chosen = raw.data
    .filter(
      (row) =>
        Number(row.pricing?.prompt) > 0 &&
        Number(row.pricing?.completion) === 0 &&
        Array.isArray(row.supported_voices) &&
        row.supported_voices.some((voice) => voice.startsWith('en-US')) &&
        Object.keys(row.pricing).every(
          (key) => ['prompt', 'completion'].includes(key) || Number(row.pricing[key]) === 0,
        ),
    )
    .sort((a, b) => Number(a.pricing.prompt) - Number(b.pricing.prompt))[0]
  if (!chosen)
    throw new Error(
      'No character-priced speech model with an advertised English voice is available',
    )
  const model = parseModelsResponse({ data: [chosen] }).media[0],
    prompt = 'The blue cup is on the table.'
  let speech = budget.ledger.find((row) => row.operation === 'openrouter-dedicated-speech')
  let file
  if (speech) {
    if (!process.argv.includes('--recover-speech'))
      throw new Error(
        'Inspect the published speech clip and pass --recover-speech; do not repeat a paid request',
      )
    const matches = (await readdir(directory)).filter(
      (name) =>
        name.startsWith(`media-${model.id.replace(/[^a-zA-Z0-9._-]/g, '-')}`) &&
        name.endsWith('.mp3'),
    )
    if (matches.length !== 1)
      throw new Error('The existing reservation cannot be matched to one published speech clip')
    file = { path: join(directory, matches[0]), mime: 'audio/mpeg', modality: 'audio' }
  } else {
    speech = await budget.reserve(
      'openrouter-dedicated-speech',
      Math.max(0.25, Number(chosen.pricing.prompt) * prompt.length * 2),
    )
    const audio = await runMediaGeneration(
      { generator, outDir: directory, maxOutputBytes: 8388608 },
      {
        model: model.id,
        protocol: 'speech',
        inputSchema: model.inputSchema,
        output: 'audio',
        prompt,
        options: {
          voice: chosen.supported_voices.find((voice) => voice.startsWith('en-US')),
          response_format: 'mp3',
        },
      },
      AbortSignal.timeout(90000),
    )
    file = audio.files[0]
  }
  if (file?.mime !== 'audio/mpeg' || (await stat(file.path)).size > 8388608)
    throw new Error('Speech produced no bounded MP3 artifact')
  const probe = await parseFile(file.path, { duration: true, skipCovers: true })
  const seconds = Number(probe.format.duration)
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 20)
    throw new Error('Speech duration cannot be safely reserved for transcription')
  const speechResult = {
    model: model.id,
    protocol: 'speech',
    durationSeconds: seconds,
    bytes: (await stat(file.path)).size,
    files: [file],
    billedCost: 'not reported',
  }
  await budget.complete(speech, speechResult)
  results.push(speechResult)
  const sttRaw = await models('transcription')
  const stt = sttRaw.data
    .filter((row) => Number(row.pricing?.prompt) > 0 && Number(row.pricing?.completion) === 0)
    .sort((a, b) => Number(a.pricing.prompt) - Number(b.pricing.prompt))[0]
  if (!stt) throw new Error('No priced transcription model is available')
  const sttModel = parseModelsResponse({ data: [stt] }).media[0]
  const reservation = await budget.reserve(
    'openrouter-dedicated-transcription',
    Math.max(0.25, Number(stt.pricing.prompt) * seconds * 2),
  )
  const transcript = await runMediaGeneration(
    { generator, outDir: directory, maxOutputBytes: 8388608 },
    {
      model: sttModel.id,
      protocol: 'transcription',
      inputSchema: sttModel.inputSchema,
      output: 'text',
      prompt: '',
      inputs: [{ kind: 'audio', url: file.path }],
      options: { language: 'en', response_format: 'json' },
    },
    AbortSignal.timeout(60000),
  )
  if (!transcript.text?.trim()) throw new Error('Transcription produced no text')
  const textResult = {
    model: sttModel.id,
    protocol: 'transcription',
    text: transcript.text,
    usage: transcript.raw?.usage ?? null,
  }
  await budget.complete(reservation, textResult)
  results.push(textResult)
  await writeFile(
    join(directory, 'qualification.json'),
    `${JSON.stringify({ results, reservedUsd: budget.reservedUsd }, null, 2)}\n`,
  )
  console.log(JSON.stringify({ results, reservedUsd: budget.reservedUsd }, null, 2))
} finally {
  await budget.close()
}
