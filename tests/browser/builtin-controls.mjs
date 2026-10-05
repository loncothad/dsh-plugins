/** Built-in controls against installed DSH packages and native configuration APIs. No paid inference. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const out = resolve('.qualification/builtin-controls-browser'),
  log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Private startup URLs exclude terminal control sequences.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw Error('Start the packed temporary fixture profile')
await mkdir(out, { recursive: true })
const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox'],
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  failures = []
page.setDefaultTimeout(25000)
page.on('pageerror', (e) => failures.push(e.message.replace(/token=[^\s"']+/g, 'token=[redacted]')))
const rpc = (method, args) =>
  page.evaluate(
    async ({ method, args }) => {
      const response = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload: { args },
        }),
      })
      return (await response.json()).result
    },
    { method, args },
  )
const view = async () => {
  const r = await rpc('builtinControls/read', { catalog: 'host' })
  if (!r.ok) throw Error(r.error.message)
  return JSON.parse(r.value)
}
const controls = page.getByRole('region', { name: 'Built-in controls', exact: true }),
  presetSwitch = controls.getByRole('switch', { name: 'standard: tool-todo', exact: true })
async function open() {
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const back = page.getByRole('button', { name: 'Back to plugins', exact: true })
  if (await back.count()) await back.click()
  await page.getByText('Built-in Controls', { exact: true }).first().click()
  await controls.waitFor()
  await presetSwitch.waitFor()
}
const switched = async (control, value) =>
  page.waitForFunction(
    ({ name, value }) =>
      [...document.querySelectorAll('[role=switch]')].some(
        (s) => s.getAttribute('aria-label') === name && s.getAttribute('aria-checked') === value,
      ),
    { name: await control.getAttribute('aria-label'), value: String(value) },
  )
async function geometry(name) {
  // Native sidebar and page sizing settle after viewport and theme changes.
  await page.waitForTimeout(400)
  const result = await controls.evaluate((node) => ({
    width: node.clientWidth,
    overflow: node.scrollWidth > node.clientWidth + 2,
  }))
  if (result.overflow) throw Error(`${name} overflows horizontally`)
  checks.push({ layout: name, ...result })
  await page.screenshot({ path: join(out, `${name}.png`) })
}
try {
  await page.goto(url)
  await page.waitForTimeout(1400)
  await open()
  const baseline = await view(),
    baselinePreset = baseline.presets.find((p) => p.id === 'standard'),
    baselineTodo = baselinePreset?.rows.find((r) => r.label === 'tool-todo')
  if (baselineTodo?.ownDisabled) {
    const reset = await rpc('builtinControls/changePreset', {
      entry: baselinePreset.entry,
      path: baselineTodo.path,
      mode: 'default',
      revision: baselinePreset.revision,
    })
    if (!reset.ok) throw Error(reset.error.message)
    await controls.getByRole('button', { name: 'Refresh', exact: true }).click()
    await switched(presetSwitch, true)
  }
  const initial = await view(),
    original = initial.presets.find((p) => p.id === 'standard')
  if (!original) throw Error('Standard preset is not exposed')
  await geometry('presets-desktop')
  const before = await presetSwitch.getAttribute('aria-checked')
  await presetSwitch.click()
  await switched(presetSwitch, before !== 'true')
  await controls.getByText('Saved for new or resumed chats.', { exact: false }).waitFor()
  const changed = await view(),
    current = changed.presets.find((p) => p.id === 'standard'),
    todo = current.rows.find((r) => r.label === 'tool-todo')
  if (todo.ownDisabled === (before !== 'true')) throw Error('Native preset toggle was not saved')
  const stale = await rpc('builtinControls/changePreset', {
    entry: original.entry,
    path: todo.path,
    mode: 'on',
    revision: original.revision,
  })
  if (stale.ok || !stale.error.message.includes('changed elsewhere'))
    throw Error('Stale preset mutation was accepted')
  checks.push('Native preset switch saves only its component; stale revision is rejected')
  await controls
    .locator('article')
    .filter({ has: page.getByRole('switch', { name: 'standard: tool-todo', exact: true }) })
    .getByRole('button', { name: 'Restore default', exact: true })
    .click()
  await switched(presetSwitch, before === 'true')
  const restored = await view()
  if (
    JSON.stringify(restored.presets.find((p) => p.id === 'standard').rows) !==
    JSON.stringify(original.rows)
  )
    throw Error('Restore default changed unrelated preset components')
  checks.push('Inherited defaults restore the original preset components')
  await controls.getByRole('tab', { name: 'Agent presets', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await controls.getByRole('tab', { name: 'Runtime components', exact: true }).waitFor()
  if (
    (await controls
      .getByRole('tab', { name: 'Runtime components', exact: true })
      .getAttribute('aria-selected')) !== 'true'
  )
    throw Error('Keyboard tabs do not select the next category')
  checks.push('Keyboard tabs select categories and keep focus')
  const native = initial.runtime.find((r) => r.module === '@deepseek-ai/dsh-client-ui-skill')
  if (!native || native.reason) throw Error('No reversible native skill UI component is available')
  const runtimeSwitch = controls.getByRole('switch', { name: native.label, exact: true })
  await controls
    .getByRole('textbox', { name: 'Search names and modules', exact: true })
    .fill(native.module)
  await runtimeSwitch.click()
  await switched(runtimeSwitch, !native.enabled)
  await runtimeSwitch.click()
  await switched(runtimeSwitch, native.enabled)
  checks.push('Native runtime component disables and re-enables through the public manager')
  await controls.getByRole('textbox', { name: 'Search names and modules', exact: true }).fill('')
  const protectedRow = initial.runtime.find((r) => r.reason === 'Required for host management')
  if (
    !protectedRow ||
    !(await controls.getByRole('switch', { name: protectedRow.label, exact: true }).isDisabled())
  )
    throw Error('Required host component is not clearly locked')
  checks.push('Required management components are locked with a reason')
  await controls.getByRole('tab', { name: 'Skills', exact: true }).click()
  const skill =
    initial.skills.find((s) => s.name === 'execution-policy') ??
    initial.skills.find((s) => s.modelInvocable && s.userInvocable)
  if (!skill) throw Error('No invocable local skill is available')
  const skillSwitch = controls.getByRole('switch', { name: skill.name, exact: true })
  await skillSwitch.click()
  await switched(skillSwitch, false)
  await page.waitForTimeout(700)
  const disabled = (await view()).skills.find((s) => s.name === skill.name)
  if (!disabled?.disabled || disabled.modelInvocable || disabled.userInvocable)
    throw Error('Skill invocation was not blocked')
  checks.push('Disabled skill is blocked for both model and human loading')
  await page.reload()
  await open()
  await controls.getByRole('tab', { name: 'Skills', exact: true }).click()
  await switched(skillSwitch, false)
  await skillSwitch.click()
  await switched(skillSwitch, true)
  await page.waitForTimeout(700)
  if ((await view()).skills.find((s) => s.name === skill.name)?.disabled)
    throw Error('Original skill did not return')
  checks.push('Skill choice persists across page reload and restores its original provider')
  await page.setViewportSize({ width: 390, height: 844 })
  await geometry('skills-mobile')
  await page.emulateMedia({ colorScheme: 'dark' })
  await geometry('skills-mobile-dark')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await geometry('skills-desktop-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Built-in plugins', exact: true }).click()
  await page.getByRole('tab', { name: 'Controls', exact: true }).click()
  await page
    .getByRole('dialog')
    .getByRole('region', { name: 'Built-in controls', exact: true })
    .waitFor()
  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('.dsh-builtin-controls [id]')].map((n) => n.id)
    return ids.length !== new Set(ids).size
  })
  if (duplicateIds) throw Error('Plugins and Settings controls use duplicate accessibility IDs')
  checks.push('Native Built-in plugins settings exposes Controls beside the diagnostic inventory')
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
