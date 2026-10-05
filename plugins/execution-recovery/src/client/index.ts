import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  configurationTheme,
  privateStateClient,
  registerConfiguration,
  registerConversationPanel,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h } from 'react'
import { recoveryView } from '../view.ts'
export const inject = ['slots', 'locale', 'configForms', 'settingsSchema', 'sessions', 'remote']
export function apply(ctx: Context): void {
  const useJobs = privateStateClient(ctx, 'executionRecovery', (value) => recoveryView.parse(value))
  function Introduction() {
    return h(
      'section',
      null,
      h('h3', null, 'Ownership expires; history remains'),
      h(
        'p',
        null,
        'Plugin consumers acquire a durable lease before work. Healthy owners renew it; an expired or replaced owner cannot publish. Failed or uncertain operations remain inspectable through /runs dead.',
      ),
      h(
        'p',
        null,
        'A model statement cannot reconcile an unknown side effect. Recovery does not blindly retry an external action. Consumers declare replay safety and reserve their own API spending before dispatch.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-execution-recovery',
    rowId: 'execution-recovery',
    before: Introduction,
  })
  function Runs(props: PropsRuntime<'conversation.input.left'>) {
    const jobs = useJobs(props.sessionId)
    if (!jobs?.length)
      return h('p', null, 'No plugin runs have been recorded for this conversation.')
    const dead = jobs.filter((job) => job.status === 'dead').length
    return h(
      'section',
      { className: 'dsh-plugin-settings dsh-plugin-panel' },
      h('style', null, configurationTheme),
      h('p', null, `Plugin runs · ${jobs.length} recent${dead ? ` · ${dead} dead letters` : ''}`),
      h(
        'ol',
        null,
        ...jobs
          .toReversed()
          .map((job) =>
            h(
              'li',
              { key: job.id },
              h('strong', null, `${job.kind} · ${job.status}`),
              h(
                'p',
                null,
                `${job.id.slice(0, 12)} · attempt ${job.attempts}/${job.maxAttempts}${job.leaseUntil ? ` · lease expires ${new Date(job.leaseUntil).toLocaleTimeString()}` : ''}`,
              ),
              job.reason ? h('p', null, job.reason) : null,
            ),
          ),
      ),
      h(
        'p',
        null,
        'Use /runs list or /runs dead for the retained journal. Unknown side effects require reconciliation before replay.',
      ),
    )
  }
  registerConversationPanel(ctx, {
    id: 'execution-recovery',
    label: 'Plugin runs',
    order: 25,
    component: Runs,
  })
}
