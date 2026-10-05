import type { Context } from '@deepseek-ai/cordis'
import { type GenerateOptions, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-token-meter'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import z from '@deepseek-ai/schemastery'
import { nativeSurfaceUnits } from '@loncothad/dsh-evidence-harness'
import type {} from '@loncothad/dsh-execution-core'
import { editableConfig, managedApply } from '@loncothad/dsh-plugin-runtime'
import { contribution, type InspectorView, viewSchema } from './wire.ts'
export const name = 'context-inspector'
export const inject = ['llm', 'sessions', 'sessionQuery']
const schema = z.object({
  includeTextPreviews: z
    .boolean()
    .default(false)
    .description(
      'Expose bounded text previews to the authenticated human UI. Off shows counts and structure only. Credentials and external summary bodies are never requested.',
    ),
  maxMessages: z
    .number()
    .step(1)
    .min(1)
    .max(256)
    .default(128)
    .description('Maximum message rows retained per current request.'),
  previewCharacters: z
    .number()
    .step(1)
    .min(64)
    .max(16384)
    .default(1024)
    .description('Per-message preview limit; image/audio/file payloads are never copied.'),
  totalPreviewCharacters: z
    .number()
    .step(1)
    .min(256)
    .max(65536)
    .default(32768)
    .description(
      'Aggregate preview limit per session snapshot. Truncation is explicitly visible through counts and omitted messages.',
    ),
  retentionUnits: z
    .number()
    .step(1)
    .min(1)
    .max(256)
    .default(128)
    .description('Maximum protocol units shown for current evidence retention ranking.'),
})
export const Config = editableConfig(schema)
interface Policy {
  includeTextPreviews: boolean
  maxMessages: number
  previewCharacters: number
  totalPreviewCharacters: number
  retentionUnits: number
}
const empty = (): InspectorView => ({
  available: false,
  capturedAt: null,
  provider: null,
  model: null,
  contextWindow: null,
  maxOutputTokens: null,
  requestTokens: null,
  estimateKind: 'Unknown; no main-agent request captured in this host generation',
  envelopeHeuristic: null,
  messageCount: 0,
  omittedMessages: 0,
  tools: [],
  messages: [],
  retention: [],
  prunedRanges: [],
  environment: 'Unknown',
  evidenceState: 'unverified',
  summaryVisibility:
    'External summaries are private presentation references and excluded from request messages and evidence compaction.',
})
export function requestView(
  options: GenerateOptions,
  policy: Policy,
  redact: (text: string) => string = (text) => text,
): InspectorView {
  let remaining = policy.totalPreviewCharacters
  const rows = options.messages.slice(-policy.maxMessages).map((message) => {
    const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
      preview = policy.includeTextPreviews
        ? redact(text).slice(0, Math.min(policy.previewCharacters, remaining))
        : undefined
    if (preview) remaining -= preview.length
    return {
      role: message.role,
      blocks: message.content.map((block) => block.type).slice(0, 64),
      characters: text.length,
      ...(preview ? { preview } : {}),
    }
  })
  return {
    ...empty(),
    available: true,
    capturedAt: new Date().toISOString(),
    provider: options.provider,
    model: options.model,
    maxOutputTokens: options.maxTokens ?? null,
    envelopeHeuristic: Math.ceil(
      Buffer.byteLength(
        JSON.stringify({
          provider: options.provider,
          model: options.model,
          system: options.system,
          messages: options.messages,
          tools: options.tools,
        }),
        'utf8',
      ) / 3,
    ),
    messageCount: options.messages.length,
    omittedMessages: Math.max(0, options.messages.length - rows.length),
    messages: rows,
    tools: (options.tools ?? []).map((tool) => tool.name).slice(0, 1024),
  }
}
function activate(ctx: Context, input: Partial<Policy>): void {
  const policy = schema(input) as Policy,
    snapshots = new WeakMap<Session, InspectorView>()
  ctx.on('llm/stream', (options, next) => {
    if (isAgentLoopRequest(options) && options.sessionId) {
      const session = ctx.sessions.get(options.sessionId)
      if (session)
        snapshots.set(
          session,
          requestView(options, policy, (text) => ctx.get('secretsBroker')?.redact(text) ?? text),
        )
    }
    return next()
  })
  const read = async (sessionId: string) => {
    const session = ctx.sessions.get(SessionId(sessionId))
    if (!session) throw new Error('Open the session before inspecting current context')
    const view = snapshots.get(session) ?? empty(),
      route = session.requestContext(),
      measurement = ctx.get('tokenMeter')?.measure(session),
      surface = await ctx.sessionQuery.readSurface(session.id),
      log = await ctx.sessionQuery.readSession(session.id)
    const retention = nativeSurfaceUnits(session, surface)
      .slice(-policy.retentionUnits)
      .map((unit) => ({
        id: unit.id,
        kind: unit.kind,
        seqs: unit.content.seqs.map(Number).slice(0, 256),
        mandatory: Boolean(unit.mandatory),
        closed: unit.closed,
        importance: unit.importance ?? null,
        reasons: [...(unit.importanceReasons ?? [])],
      }))
    const prunedRanges = log.events
      .filter((event) => event.type === 'compaction/prune')
      .slice(-64)
      .map((event) => ({
        seqs: event.data.shadowedSeqs.map(Number).slice(0, 256),
        tokens: event.data.shadowedTokenCount,
      }))
    return viewSchema.parse({
      ...view,
      contextWindow: route?.contextWindow ?? null,
      requestTokens: measurement?.totalTokens ?? null,
      estimateKind:
        measurement?.baseline.kind === 'usage'
          ? 'Provider usage anchor with native heuristic surface adjustments'
          : 'Native token estimate; UTF-8 envelope heuristic shown separately',
      retention,
      prunedRanges,
      environment: ctx.get('environmentIsolation')?.environment ?? 'Single profile',
      evidenceState: ctx.get('evidenceAuthority')?.check(sessionId).state ?? 'unverified',
    })
  }
  ctx.inject(['typert'], (scope) => {
    class Inspector extends TypertRemoteService {
      constructor() {
        super(scope, 'contextInspector')
        scope.typert.register({
          package: contribution.package,
          face: 'host',
          model: { services: [], events: [], objects: [] },
          schemas: [],
          invocations: contribution.descriptors,
        })
      }
      async read(sessionId: string): Promise<InspectorView> {
        if (!this.ctx.invocation)
          throw new Error('Context inspection requires the authenticated human Gateway')
        return read(sessionId)
      }
    }
    new Inspector()
  })
}
export const apply = managedApply(schema, activate)
