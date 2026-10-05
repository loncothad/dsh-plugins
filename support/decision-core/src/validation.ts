import type { DecisionInput, DecisionQuestion, DecisionResult } from './types.ts'

export type { DecisionInput, DecisionQuestion, DecisionResult } from './types.ts'
export interface DecisionRequest {
  question: string
  choices: readonly string[]
  state?: string
}
export interface DecisionAnswer {
  choice: string
  confidence?: number
  probabilities?: Record<string, number>
  rationale?: string
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a decision object')
  return value as Record<string, unknown>
}
export function validateDecisionInput(value: unknown): DecisionInput {
  const row = object(value)
  if (
    Object.keys(row).some((key) => !['state', 'questions', 'images'].includes(key)) ||
    row.state === undefined ||
    Buffer.byteLength(JSON.stringify({ state: row.state, questions: row.questions })) > 131072
  )
    throw new Error('Decision request exceeds its schema or 128 KiB limit')
  const questions = object(row.questions),
    entries = Object.entries(questions)
  if (entries.length < 1 || entries.length > 64) throw new Error('Choose 1 to 64 questions')
  for (const [id, raw] of entries) {
    const question = object(raw)
    if (
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(id) ||
      question.instructions === undefined ||
      (typeof question.instructions === 'string' && !question.instructions.trim()) ||
      Buffer.byteLength(JSON.stringify(question.instructions)) > 16384
    )
      throw new Error('Each question needs an ID and bounded instructions')
    if (Object.keys(question).some((key) => !['type', 'instructions', 'criteria'].includes(key)))
      throw new Error('Unsupported decision question field')
    if (question.type === 'choice') {
      const criteria = object(question.criteria),
        choices = Object.entries(criteria)
      if (
        choices.length < 2 ||
        choices.length > 128 ||
        choices.some(
          ([key, label]) =>
            !key ||
            key.length > 1024 ||
            label === undefined ||
            label === '' ||
            Buffer.byteLength(JSON.stringify(label)) > 4096,
        )
      )
        throw new Error('Supply 2 to 128 named choices with descriptions')
    } else if (question.type === 'score') {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > 10 ||
        question.criteria.some(
          (item) =>
            item === undefined || item === '' || Buffer.byteLength(JSON.stringify(item)) > 4096,
        )
      )
        throw new Error('Supply 2 to 10 ordered score descriptions')
    } else {
      if (question.type !== 'noul') throw new Error('Use choice, score or noul questions')
      if (
        question.criteria !== undefined &&
        Object.keys(object(question.criteria)).some((key) => !['true', 'false'].includes(key))
      )
        throw new Error('Boolean criteria use true and false keys')
    }
  }
  if (
    row.images !== undefined &&
    (!Array.isArray(row.images) ||
      row.images.length > 4 ||
      row.images.some(
        (image) =>
          typeof image !== 'string' &&
          (!image ||
            typeof image !== 'object' ||
            typeof image.content_type !== 'string' ||
            typeof image.base64 !== 'string'),
      ))
  )
    throw new Error('Supply up to four embedded images')
  if (Buffer.byteLength(JSON.stringify(row)) > 13 * 1024 * 1024)
    throw new Error('Decision request exceeds 13 MiB')
  return {
    state: row.state,
    questions: questions as Record<string, DecisionQuestion>,
    ...(row.images === undefined ? {} : { images: row.images as DecisionInput['images'] }),
  }
}
const probability = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
export function parseDecisionResult(value: unknown, input: DecisionInput): DecisionResult {
  let row = object(value)
  if ('success' in row) {
    if (row.success !== true) throw new Error('Cloudflare rejected the decision')
    row = object(row.result)
  }
  const raw = object(row.answers),
    answers: DecisionResult['answers'] = Object.create(null)
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = object(raw[id])
    if (answer.type !== question.type) throw new Error('Decision response protocol mismatch')
    const next: Record<string, unknown> = { type: answer.type }
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice))
        throw new Error('Decision returned a choice outside the allowed set')
      next.choice = answer.choice
    } else if (question.type === 'noul') {
      if (!probability(answer.noul)) throw new Error('Invalid boolean decision probability')
      next.noul = answer.noul
    } else {
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > question.criteria.length - 1
      )
        throw new Error('Invalid ordered decision score')
      next.score = answer.score
      next.legend = Object.fromEntries(
        question.criteria.map((item, index) => [String(index), item]),
      )
    }
    if (answer.confidence !== undefined) {
      if (!probability(answer.confidence)) throw new Error('Invalid model-reported confidence')
      next.confidence = answer.confidence
    }
    if (answer.probabilities !== undefined) {
      const values = object(answer.probabilities),
        keys =
          question.type === 'choice'
            ? Object.keys(question.criteria)
            : question.type === 'score'
              ? question.criteria.map((_, index) => String(index))
              : []
      if (
        Object.keys(values).length !== keys.length ||
        keys.some((key) => !probability(values[key]))
      )
        throw new Error('Invalid per-option probabilities')
      const sum = Object.values(values).reduce<number>((sum, value) => sum + Number(value), 0)
      if (Math.abs(sum - 1) > 0.02) throw new Error('Decision probabilities do not sum to one')
      next.probabilities = values
    }
    answers[id] = next
  }
  const usage: Record<string, number> = {}
  if (row.usage && typeof row.usage === 'object')
    for (const [key, value] of Object.entries(row.usage))
      if (
        ['input_tokens', 'output_tokens', 'cost'].includes(key) &&
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0
      )
        usage[key] = value
  return {
    model: typeof row.model === 'string' ? row.model : 'unknown',
    answers,
    status: 'unverified',
    ...(Object.keys(usage).length ? { usage } : {}),
  }
}
export function choiceInput(request: DecisionRequest): DecisionInput {
  return validateDecisionInput({
    state: request.state ?? '',
    questions: {
      decision: {
        type: 'choice',
        instructions: request.question,
        criteria: Object.fromEntries(request.choices.map((choice) => [choice, choice])),
      },
    },
  })
}
