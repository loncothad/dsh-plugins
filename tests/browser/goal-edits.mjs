/** Review and replacement behavior in a temporary installed DSH profile, without paid inference. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const out = resolve('.qualification/goal-edits-browser'),
  log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Startup URL excludes terminal control sequences.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw Error('Start the private packed fixture profile')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox'],
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  failures = []
let sessionId
page.setDefaultTimeout(25000)
page.on('pageerror', (e) => failures.push(e.message.replace(/token=[^\s"']+/g, 'token=[redacted]')))
page.on('response', async (r) => {
  if (r.url().endsWith('/api/session/create')) {
    const j = await r.json().catch(() => null)
    if (j?.result?.ok) sessionId = j.result.value.sessionId
  }
})
const rpc = async (method, args) =>
  page.evaluate(
    async ({ method, args }) => {
      const r = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload: { args },
        }),
      })
      return (await r.json()).result
    },
    { method, args },
  )
const command = async (text) => {
  const r = await rpc('commands/execute', {
    agentId: sessionId,
    line: text,
    submittedAttachments: [],
  })
  if (!r.ok || r.value?.result.kind !== 'success')
    throw Error(r.error?.message ?? r.value?.result.text ?? 'Command failed')
}
const state = async () => {
  const r = await rpc('pluginState_goalBook/read', { sessionId })
  if (!r.ok) throw Error(r.error.message)
  return JSON.parse(r.value)
}
const panel = async () => {
  await page.getByRole('button', { name: 'Session tools', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Plan & goals', exact: true }).click()
  await page.getByRole('dialog', { name: 'Plan & goals', exact: true }).waitFor()
}
const close = async () => {
  await page.getByRole('button', { name: 'Close session tools', exact: true }).click()
}
const answer = async () => {
  await page.getByText('Which completion checks should the goal use?', { exact: true }).waitFor()
  await page.getByText('Tests and review', { exact: true }).first().click()
  const submit = page.getByRole('button', { name: 'Submit', exact: true })
  if (await submit.isVisible()) await submit.click()
}
try {
  await page.goto(url)
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const back = page.getByRole('button', { name: 'Back to plugins', exact: true })
  if (await back.count()) await back.click()
  await page.getByText('Plan & Goals', { exact: true }).first().click()
  await page.locator('form').waitFor()
  await page.locator('#plan-goals-regularRoundLimit').fill('1')
  if (await page.getByRole('button', { name: 'Save configuration', exact: true }).isEnabled())
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.waitForTimeout(1500)

  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: 'Local qualification model', exact: true }).click()
  const editor = page.locator('[data-composer-input=true]')
  await editor.fill('Begin local goal edit qualification.')
  await editor.press('Enter')
  await page
    .getByText('Controlled local qualification completed. No external provider was contacted.', {
      exact: true,
    })
    .last()
    .waitFor()
  if (!sessionId) throw Error('Native session identity is unavailable')
  await command(
    `/goal-settings ${JSON.stringify({ revision: 0, settings: { auditMode: 'off', compactAfterTask: false } })}`,
  )
  await command('/goal Qualify distinct goal changes')
  await answer()
  await panel()
  await page.getByRole('button', { name: 'Confirm and start goal', exact: true }).click()
  await close()
  await page.waitForTimeout(1500)
  let book = await state(),
    original = book.goals.find((g) => g.id === book.focused),
    task = original.tasks[0]
  await command(
    `/qualification-goal-tool ${JSON.stringify({ tool: 'goal_task', args: { revision: original.revision, taskId: task.id, done: true, evidence: 'Local fixture receipt; no provider was contacted.' } })}`,
  )
  await panel()
  await page.getByLabel('Change to current goal', { exact: true }).fill('Add an encoding check')
  await page.getByRole('button', { name: 'Review amendment', exact: true }).click()
  await close()
  await answer()
  await panel()
  await page.getByRole('heading', { name: 'Review goal amendment', exact: true }).waitFor()
  await page.getByRole('region', { name: 'Proposed goal changes', exact: true }).waitFor()
  await page.getByText(/1 completed tasks retained/).waitFor()
  book = await state()
  if (book.draft !== original.id) throw Error('Amendment changed logical identity')
  await page.screenshot({ path: join(out, 'amendment-desktop.png') })
  await close()
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
  if (await collapse.isVisible()) await collapse.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  await panel()
  const dialog = page.getByRole('dialog', { name: 'Plan & goals', exact: true })
  if (await dialog.evaluate((n) => n.scrollWidth > n.clientWidth + 2))
    throw Error('Amendment review overflows mobile')
  await page.screenshot({ path: join(out, 'amendment-mobile.png') })
  await page.getByRole('button', { name: 'Confirm amendment and resume', exact: true }).click()
  await close()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.waitForTimeout(1700)
  book = await state()
  const amended = book.goals.find((g) => g.id === book.focused)
  if (
    amended.id !== original.id ||
    amended.nativeId !== original.nativeId ||
    amended.tasks[0]?.id !== task.id ||
    !amended.tasks[0]?.done
  )
    throw Error('Amendment lost native identity or retained evidence')
  checks.push(
    'Amendment keeps logical/native identity and completed evidence, with a full changes review',
  )
  await panel()
  await page.getByLabel('Goal change action', { exact: true }).selectOption('replace')
  await page.getByLabel('New goal', { exact: true }).fill('A fresh parser goal')
  await page.getByRole('button', { name: 'Review replacement', exact: true }).click()
  await close()
  await answer()
  await panel()
  await page.getByRole('heading', { name: 'Review replacement goal', exact: true }).waitFor()
  await page
    .getByText(
      'Fresh goal and task list. The source goal stays paused and is archived only after confirmation.',
      { exact: true },
    )
    .waitFor()
  book = await state()
  const replacement = book.goals.find((g) => g.id === book.draft),
    source = book.goals.find((g) => g.id === original.id)
  if (
    replacement.id === original.id ||
    source.phase === 'archived' ||
    replacement.tasks.some((t) => t.done || t.evidence)
  )
    throw Error('Replacement reused progress or archived the source early')
  await page.screenshot({ path: join(out, 'replacement-desktop.png') })
  await page.getByRole('button', { name: 'Cancel draft', exact: true }).click()
  await close()
  await page.waitForTimeout(1700)
  book = await state()
  if (book.draft || book.focused !== original.id || book.goals.some((g) => g.id === replacement.id))
    throw Error('Cancelled replacement lost the source')
  checks.push('Replacement has a fresh plan; cancellation retains the source goal')
  await command('/goal-replace Fresh parser after review')
  await answer()
  await panel()
  await page.getByRole('heading', { name: 'Review replacement goal', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm replacement and start', exact: true }).click()
  await page.waitForTimeout(1700)
  book = await state()
  const accepted = book.goals.find((g) => g.id === book.focused),
    old = book.goals.find((g) => g.id === original.id)
  if (
    accepted.replaces !== old.id ||
    old.replacedBy !== accepted.id ||
    old.phase !== 'archived' ||
    old.tasks[0]?.evidence !== 'Local fixture receipt; no provider was contacted.'
  )
    throw Error('Confirmed replacement did not retain linked history')
  await page.getByText(/^Saved goals \(/).click()
  await page.getByLabel('Open goal', { exact: true }).selectOption(old.id)
  await page.getByRole('region', { name: 'Saved goal details', exact: true }).waitFor()
  await page.screenshot({ path: join(out, 'saved-history.png') })
  checks.push('Confirmation archives the source with linked, inspectable evidence')
} catch (e) {
  failures.push(e.message.replace(/token=[^\s"']+/g, 'token=[redacted]'))
  await page.screenshot({ path: join(out, 'failure.png') })
} finally {
  await browser.close()
  const report = { checkedAt: new Date().toISOString(), checks, failures, paidInferenceCalls: 0 }
  await writeFile(join(out, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (failures.length) process.exitCode = 1
}
