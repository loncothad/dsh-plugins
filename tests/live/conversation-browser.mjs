/** Native composer, shared routing, attachments and ordered checkpoints against a local fixture provider. */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from '../browser/harness.mjs'

const directory = resolve('.qualification/browser-results'),
  log = await fixtureLog(),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberate control-character filtering at an input or log boundary.
  url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw new Error('Start the private packed profile before qualification')
const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox'],
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  failures = [],
  checks = []
page.setDefaultTimeout(20000)
const clean = (value) => String(value).replace(/token=[^\s"']+/g, 'token=[redacted]')
page.on('pageerror', (error) => failures.push(clean(error.message)))
const openPanel = async (label) => {
  const close = page.getByRole('button', { name: 'Close session tools', exact: true })
  if (await close.isVisible()) await close.click()
  await page.getByRole('button', { name: 'Session tools', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await page.getByRole('dialog', { name: label, exact: true }).waitFor()
}
const selectModel = async (name) => {
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name, exact: true }).click()
}
try {
  await mkdir(directory, { recursive: true })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  if (await page.getByRole('button', { name: 'Continue', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.waitForTimeout(700)
    await page.reload()
    await page.waitForTimeout(1200)
  }
  if (await page.getByRole('button', { name: 'Configure later', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Configure later', exact: true }).click()
  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await selectModel('Local qualification model')
  await openPanel('Workspace & checkpoints')
  await page.getByRole('button', { name: 'Start isolated work session', exact: true }).click()
  await page.waitForTimeout(1500)
  if (
    await page
      .getByText(/Isolated session creation failed/)
      .last()
      .isVisible()
  )
    throw new Error(
      await page
        .getByText(/Isolated session creation failed/)
        .last()
        .innerText(),
    )
  if (
    !(await page
      .getByRole('button', { name: /Select model, current.*Local qualification model/ })
      .count())
  )
    throw new Error('Isolated session lost the selected no-network model')
  checks.push(
    'Created a native work session on an automatic branch without operating on the raw repository',
  )
  await openPanel('Plan & goals')
  await page.getByLabel('Outcome', { exact: true }).fill('Qualify the ordered goal UI')
  await page
    .getByLabel('Steps and acceptance checks', { exact: true })
    .fill(
      'Inspect configuration | Native controls render\nPrepare artifacts | Packed modules import',
    )
  await page.getByRole('button', { name: 'Start ordered goal', exact: true }).click()
  await page.getByText(/Sisyphus · review · 1\/2/).waitFor({ timeout: 45000 })
  checks.push('Native agent tool call records first proposal and pauses continuation')
  await page.screenshot({ path: join(directory, 'sisyphus-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: join(directory, 'sisyphus-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPanel('Evidence & completion')
  await openPanel('Evidence & completion')
  await page.getByRole('button', { name: 'Check evidence', exact: true }).click()
  await page.getByText('Evidence · insufficient evidence', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Attest review of this target', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Attest review of this target', exact: true }).click()
  await page.getByText('Evidence · verified', { exact: true }).waitFor()
  await openPanel('Plan & goals')
  await page.getByRole('button', { name: 'Approve current step', exact: true }).click()
  await page.getByText(/Sisyphus · review · 2\/2/).waitFor({ timeout: 45000 })
  checks.push(
    'Human approval advances exactly one step and native continuation proposes the next checkpoint',
  )
  await openPanel('Evidence & completion')
  await page.getByRole('button', { name: 'Check evidence', exact: true }).click()
  await page.getByText('Evidence · insufficient evidence', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Attest review of this target', exact: true }).click()
  await page.getByText('Evidence · verified', { exact: true }).waitFor()
  await openPanel('Plan & goals')
  await page.getByRole('button', { name: 'Approve current step', exact: true }).click()
  await page.getByText(/Sisyphus · complete · 2\/2/).waitFor()
  checks.push('Completion occurs only after both acceptance checkpoints')
  await page.screenshot({ path: join(directory, 'sisyphus-complete.png') })
  await page.getByRole('button', { name: 'Close session tools', exact: true }).click()
  await selectModel('OpenAI: GPT-4.1 Mini')
  await openPanel('Model providers')
  const panel = page.getByRole('dialog', { name: 'Model providers', exact: true })
  await panel.waitFor()
  await page.getByText('All endpoint metrics and policy evidence', { exact: true }).click()
  await page.getByRole('table').waitFor()
  const choices = panel
    .getByRole('group', { name: 'Upstream provider', exact: true })
    .getByRole('radio')
  await choices.nth(2).waitFor()
  const initial = await choices.evaluateAll((nodes) => nodes.find((node) => node.checked)?.value)
  if (!initial) throw new Error('Plugins per-model selection did not reach composer')
  const options = await choices.evaluateAll((nodes) =>
    nodes.map((node) => ({ value: node.value, disabled: node.disabled })),
  )
  const next = options.find((row) => row.value && row.value !== initial && !row.disabled)?.value
  if (!next) throw new Error('No alternate upstream endpoint is advertised')
  await panel
    .locator('input[type=radio]')
    .filter({ visible: true })
    .evaluateAll((nodes, value) => nodes.find((node) => node.value === value)?.click(), next)
  await page.getByText('Provider preference saved.', { exact: true }).waitFor()
  for (const size of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size)
    await page.waitForTimeout(250)
    const bounds = await page
      .getByRole('dialog', { name: 'Model providers', exact: true })
      .boundingBox()
    if (
      !bounds ||
      bounds.y < 0 ||
      bounds.y + bounds.height > size.height + 1 ||
      bounds.x < 0 ||
      bounds.x + bounds.width > size.width + 1
    )
      throw new Error(`Provider popup exceeds ${size.width}px viewport`)
  }
  checks.push(
    'Provider popup fits desktop/mobile viewports and uses the shared persisted preference',
  )
  await page.screenshot({ path: join(directory, 'composer-provider-final.png') })
  await panel.focus()
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  if (
    await page
      .getByRole('button', { name: 'Session tools', exact: true })
      .evaluate((node) => node !== document.activeElement)
  )
    throw new Error('Escape did not restore trigger focus')
  checks.push('Escape closes provider popup and restores focus')
  await page.setViewportSize({ width: 1440, height: 1000 })
  const mediaDirectory = process.env.DSH_QUALIFICATION_MEDIA_DIR
  if (mediaDirectory) {
    const file = (await readdir(mediaDirectory)).find((name) => /\.(png|jpg|jpeg)$/.test(name))
    if (file) {
      await page.locator('input[type=file]').setInputFiles(join(mediaDirectory, file))
      await page.waitForTimeout(800)
      if ((await page.locator('img[src^="blob:"]').count()) === 0)
        throw new Error('Native attachment preview did not render')
      checks.push('Image attachment uploads into the native composer preview')
      await page.screenshot({ path: join(directory, 'composer-attachment-final.png') })
    }
  }
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByText('OpenRouter', { exact: true }).first().click()
  await page
    .getByRole('searchbox', { name: 'Search OpenRouter models', exact: true })
    .fill('gpt-4.1-mini')
  await page.getByLabel('OpenRouter model', { exact: true }).selectOption('openai/gpt-4.1-mini')
  await page.getByText('All endpoint metrics and policy evidence', { exact: true }).click()
  await page.getByRole('table').waitFor()
  if (
    (await page
      .getByRole('group', { name: 'Upstream provider', exact: true })
      .locator('input[type=radio]:checked')
      .inputValue()) !== next
  )
    throw new Error('Composer selection did not persist to Plugins')
  checks.push('Composer selection survives navigation into Plugins')
} catch (error) {
  failures.push(clean(error.message))
  console.log(clean((await page.locator('body').innerText()).slice(-5000)))
  await page.screenshot({ path: join(directory, 'conversation-failure.png') })
} finally {
  await browser.close()
  const report = {
    checkedAt: new Date().toISOString(),
    checks,
    failures,
    fixture: 'Temporary local provider; no model API calls for ordered goal behavior.',
  }
  await writeFile(
    join(directory, 'conversation-qualification.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
  if (failures.length) process.exitCode = 1
}
