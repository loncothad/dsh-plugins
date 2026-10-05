/** Native permission presets and real file/shell tools against installed tarballs. No paid calls. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const out = resolve('.qualification/full-access-browser'),
  log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Private startup URL excludes terminal control sequences.
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
let sessionId
page.setDefaultTimeout(25000)
page.on('pageerror', (e) => failures.push(e.message.replace(/token=[^\s"']+/g, 'token=[redacted]')))
page.on('response', async (r) => {
  if (r.url().endsWith('/api/session/create')) {
    const j = await r.json().catch(() => null)
    if (j?.result?.ok) sessionId = j.result.value.sessionId
  }
})
const rpc = (method, args) =>
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
const command = async (line, expected = 'success') => {
  const r = await rpc('commands/execute', { agentId: sessionId, line, submittedAttachments: [] })
  if (!r.ok || r.value?.result.kind !== expected)
    throw Error(r.error?.message ?? r.value?.result.text ?? 'Command failed')
  return r.value.result.text
}
const configure = async (honor) => {
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const back = page.getByRole('button', { name: 'Back to plugins', exact: true })
  if (await back.count()) await back.click()
  await page.getByText('Policy Engine', { exact: true }).first().click()
  const field = page.locator('#policy-engine-honorFullAccess')
  await field.selectOption(String(honor))
  const save = page.getByRole('button', { name: 'Save configuration', exact: true })
  if (await save.isEnabled()) await save.click()
  await page.waitForTimeout(1300)
  await page.reload()
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  if (await back.count()) await back.click()
  await page.getByText('Policy Engine', { exact: true }).first().click()
  await field.waitFor()
  if ((await field.inputValue()) !== String(honor))
    throw Error('Full Access setting did not reload')
  return field
}
try {
  await page.goto(url)
  await page.waitForTimeout(1400)
  const field = await configure(true)
  await field.focus()
  await page.screenshot({ path: join(out, 'configuration-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(out, 'configuration-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  checks.push('Native configuration control saves and reloads on desktop and mobile')
  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: 'Local qualification model', exact: true }).click()
  const editor = page.locator('[data-composer-input=true]')
  await editor.fill('Begin local Full Access qualification.')
  await editor.press('Enter')
  await page
    .getByText('Controlled local qualification completed. No external provider was contacted.', {
      exact: true,
    })
    .last()
    .waitFor()
  if (!sessionId) throw Error('Native session identity is unavailable')
  await command('/permission danger-full-access')
  const policy = JSON.parse(await command('/policy'))
  if (policy.permissionPreset !== 'danger-full-access' || !policy.honorFullAccess)
    throw Error('Policy does not resolve the real native Full Access preset')
  for (const tool of ['write', 'edit', 'bash']) {
    const text = await command(`/qualification-permission-tool ${tool}`)
    if (JSON.parse(text).isError) throw Error(`Native ${tool} failed in Full Access`)
    checks.push(`Native ${tool} executes in Full Access without review`)
  }
  if (await page.getByRole('region', { name: 'Review policy action', exact: true }).count())
    throw Error('Full Access leaves a review prompt')
  await configure(false)
  const refusal = await command('/qualification-permission-tool write', 'error')
  if (!refusal.includes('APPROVAL_DISABLED') || !refusal.includes('configuration conflict'))
    throw Error('Explicitly retained review has no clear disabled-approval explanation')
  checks.push('Operator can retain default reviews; Never reports the configuration conflict')
  await configure(true)
  await command('/qualification-permission-tool bash')
  checks.push('Restored setting applies without restarting DSH')
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
