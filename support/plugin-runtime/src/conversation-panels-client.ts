/** One native toolbar entry for optional plugin panels; members retain their own lifetimes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Button, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  createElement as h,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { configurationTheme } from './configuration-theme.ts'
export type ConversationPanelProps = PropsRuntime<'conversation.input.left'>
interface Panel {
  id: string
  label: string
  order?: number
  component: React.ComponentType<ConversationPanelProps>
  badge?: React.ComponentType<ConversationPanelProps>
  visibility?: React.ComponentType<ConversationPanelProps & { onChange(visible: boolean): void }>
}
class Panels {
  private entries: readonly Panel[] = []
  private openListeners = new Set<(sessionId: string, id: string) => void>()
  onOpen = (listener: (sessionId: string, id: string) => void) => {
    this.openListeners.add(listener)
    return () => {
      this.openListeners.delete(listener)
    }
  }
  open(sessionId: string, id: string): boolean {
    if (!this.entries.some((p) => p.id === id)) return false
    for (const listener of this.openListeners) listener(sessionId, id)
    return true
  }
  private readonly listeners = new Set<() => void>()
  read = () => this.entries
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  add(panel: Panel): () => void {
    if (this.entries.length >= 128) throw new Error('Conversation panel capacity exceeded')
    if (this.entries.some((row) => row.id === panel.id))
      throw new Error('Conversation panel already registered')
    this.entries = [...this.entries, panel].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    this.emit()
    return () => {
      this.entries = this.entries.filter((row) => row !== panel)
      this.emit()
    }
  }
  private emit() {
    for (const listener of this.listeners) listener()
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginConversationPanels: Panels
  }
}
export function registerConversationPanel(ctx: Context, panel: Panel): void {
  const root = ctx.root
  let registry = root.get('pluginConversationPanels')
  if (!registry) {
    registry = new Panels()
    root.provide('pluginConversationPanels', registry)
    const members = registry
    function Toolbar(props: ConversationPanelProps) {
      const entries = useSyncExternalStore(members.subscribe, members.read),
        trigger = useRef<HTMLButtonElement>(null),
        session = useRef(props.sessionId)
      session.current = props.sessionId
      const [menu, setMenu] = useState(false),
        [active, setActive] = useState<string>(),
        [visibility, setVisibility] = useState<Record<string, boolean>>({})
      const visibleEntries = entries.filter(
        (row) => !row.visibility || visibility[`${props.sessionId}:${row.id}`] === true,
      )
      const selected = visibleEntries.find((row) => row.id === active)
      const close = useCallback(() => {
        setActive(undefined)
        trigger.current?.focus({ preventScroll: true })
      }, [])
      useEffect(() => {
        setMenu(false)
        setActive(undefined)
        setVisibility((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([key]) => key.startsWith(`${props.sessionId}:`)),
          ),
        )
      }, [props.sessionId])
      useEffect(
        () =>
          members.onOpen((id, panel) => {
            if (id === session.current) {
              setMenu(false)
              setActive(panel)
            }
          }),
        [],
      )
      useEffect(() => {
        if (active && !selected) close()
      }, [active, selected, close])
      if (!entries.length) return null
      return h(
        'span',
        { className: 'dsh-session-tools' },
        ...entries
          .filter((row) => row.visibility)
          .map((row) =>
            h(row.visibility!, {
              ...props,
              key: row.id,
              onChange: (visible: boolean) =>
                session.current === props.sessionId &&
                setVisibility((current) =>
                  current[`${props.sessionId}:${row.id}`] === visible
                    ? current
                    : { ...current, [`${props.sessionId}:${row.id}`]: visible },
                ),
            }),
          ),
        visibleEntries.length
          ? h(Menu, {
              open: menu,
              portal: true,
              compact: true,
              selection: 'fill',
              autoFocus: true,
              onClose: () => setMenu(false),
              onSelect: (id: string) => {
                setMenu(false)
                setActive(id)
              },
              items: visibleEntries.map((row) => ({
                id: row.id,
                label: h(
                  'span',
                  { className: 'dsh-session-tool-label' },
                  row.label,
                  row.badge ? h(row.badge, props) : null,
                ),
              })),
              anchor: h(
                Button,
                {
                  ref: trigger,
                  variant: 'ghost',
                  size: 'sm',
                  type: 'button',
                  'aria-label': 'Session tools',
                  title: 'Session tools',
                  'aria-haspopup': 'menu',
                  'aria-expanded': menu,
                  onClick: () => setMenu(!menu),
                  style: { padding: '0 6px', width: 28, height: 28, position: 'relative' },
                },
                h('span', { 'aria-hidden': true, style: { fontSize: 22, lineHeight: 1 } }, '⋯'),
                ...visibleEntries
                  .filter((row) => row.badge)
                  .map((row) =>
                    h(
                      'span',
                      { key: row.id, style: { position: 'absolute', top: -3, right: -3 } },
                      h(row.badge!, props),
                    ),
                  ),
              ),
            })
          : null,
        h(
          Modal,
          {
            open: Boolean(selected),
            onClose: close,
            title: selected?.label ?? 'Session tools',
            closeLabel: 'Close session tools',
            className: 'dsh-session-panel-modal',
            contentClassName: 'dsh-session-panel-content',
          },
          h(
            'style',
            null,
            `${configurationTheme}\n.dsh-session-panel-modal{width:min(680px,100%);max-height:100%;}.dsh-session-panel-content{min-height:0;overflow:auto;}.dsh-session-tool-label{display:flex;align-items:center;justify-content:space-between;gap:20px;}.dsh-session-tool-count{font-size:11px;color:var(--dsw-alias-label-tertiary);}.dsh-plugin-settings.dsh-plugin-panel{max-width:none;width:100%;margin:0;padding:0;border:0;}.dsh-plugin-panel button{margin:4px 6px 4px 0;}.dsh-plugin-panel label{display:block;margin:12px 0 6px;}.dsh-plugin-panel label > .config-input,.dsh-plugin-panel label > textarea,.dsh-plugin-panel label > select{margin-top:6px;}.dsh-plugin-panel label input:not([type=checkbox]){width:100%;}.dsh-plugin-panel label:has(>input[type=checkbox]){display:inline-flex;align-items:center;gap:6px;}.dsh-plugin-panel label input[type=checkbox]{width:16px;flex:none;}.dsh-plugin-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;}.dsh-plugin-panel ol{padding-left:22px;}.dsh-plugin-panel li{padding:6px 0;}.dsh-plugin-panel dd{margin:0;overflow-wrap:anywhere;}`,
          ),
          selected ? h(selected.component, props) : null,
        ),
      )
    }
    root.slots.inject('conversation.input.left', () =>
      root.slots.register(
        { name: 'conversation.input.left', id: 'plugin-session-tools', order: 90 },
        Toolbar,
      ),
    )
  }
  ctx.effect(() => registry!.add(panel), 'conversation panels: own menu membership')
}

/** Open an owned panel without synthetic DOM clicks or changing the selected chat. */
export function openConversationPanel(ctx: Context, sessionId: string, id: string): boolean {
  return ctx.root.get('pluginConversationPanels')?.open(sessionId, id) ?? false
}
