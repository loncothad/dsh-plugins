import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  configurationStatus,
  configurationTheme,
  registerConfiguration,
  registerConversationPanel,
} from '@loncothad/dsh-plugin-runtime/client'
import { createElement as h, useState } from 'react'
export const inject = [
  'slots',
  'locale',
  'configForms',
  'settingsSchema',
  'remote',
  'remote.commands',
  'sessions',
  'uiWorkspace',
  'workspaces',
]
export function apply(ctx: Context): void {
  const Status = configurationStatus(ctx, 'workspace')
  function Introduction() {
    return h(
      'section',
      null,
      h(Status),
      h('h3', null, 'Keep recovery outside the working tree'),
      h(
        'p',
        null,
        'Starting an isolated session creates a fresh branch and copies current tracked and non-ignored working files. It preserves the original repository’s uncommitted work. Raw-repository model tools are blocked when isolation is required.',
      ),
      h(
        'p',
        null,
        'Checkpoints retain immutable workspace file objects and a manifest outside the repository. /checkpoint create, list, diff ID and restore ID TARGET manage recovery. Restore targets must be new empty directories; credential files are omitted and no history rewrite is performed.',
      ),
    )
  }
  registerConfiguration(ctx, {
    packageName: '@loncothad/dsh-workspace-safety',
    rowId: 'workspace-safety',
    before: Introduction,
  })
  function Workspace(props: PropsRuntime<'conversation.input.left'>) {
    const [repository, setRepository] = useState(''),
      [busy, setBusy] = useState(false),
      [message, setMessage] = useState('')
    const run = async (command: string, open = false) => {
      setBusy(true)
      try {
        const result = await ctx.remote.commands.execute(props.sessionId, command, [])
        if (!result.ok) throw new Error(result.error.message)
        if (!result.value) throw new Error('Enable Workspace Safety on the host.')
        if (result.value.result.kind === 'error') throw new Error(result.value.result.text)
        const text = result.value.result.text ?? 'Updated.'
        if (open) {
          const value = JSON.parse(text)
          await ctx.workspaces.create({ path: value.path })
          await ctx.sessions.refresh()
          ctx.uiWorkspace.openSession(value.sessionId as SessionId)
          setMessage(`Opened ${value.branch}.`)
        } else setMessage(text)
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Workspace operation failed.')
      } finally {
        setBusy(false)
      }
    }
    return h(
      'section',
      { className: 'dsh-plugin-settings dsh-plugin-panel' },
      h('style', null, configurationTheme),
      h(
        'label',
        null,
        'Repository name',
        h(Input, {
          className: 'config-input',
          value: repository,
          placeholder: 'Default configured repository',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setRepository(event.target.value),
        }),
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            void run(`/workspace start ${repository}`, true)
          },
        },
        'Start isolated work session',
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            void run('/checkpoint create')
          },
        },
        'Create checkpoint',
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            void run('/checkpoint list')
          },
        },
        'List checkpoints',
      ),
      h(
        Button,
        {
          variant: 'outline',
          size: 'sm',
          type: 'button',
          disabled: busy,
          onClick: () => {
            void run('/workspace status')
          },
        },
        'Inspect workspace',
      ),
      message
        ? h(
            'pre',
            { role: 'status', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
            message,
          )
        : null,
    )
  }
  registerConversationPanel(ctx, {
    id: 'workspace-safety',
    label: 'Workspace & checkpoints',
    order: 12,
    component: Workspace,
  })
}
