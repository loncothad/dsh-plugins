/** Exercise saved native configuration editors without provider inference. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Exclude terminal escape boundaries from the private startup URL.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
assert.ok(url)
const directory = '.qualification/editor-browser'
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(20000)
const checks = [],
  failures = []
const visit = async (title) => {
  if (
    !(await page.getByText('Install, enable, and configure plugins', { exact: true }).isVisible())
  )
    await page.getByText('Plugins', { exact: true }).last().click()
  await page.getByText('Install, enable, and configure plugins', { exact: true }).waitFor()
  await page.getByText(title, { exact: true }).first().click()
  await page.locator('form').waitFor()
}
const save = async (title) => {
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.getByText('Unsaved changes', { exact: true }).waitFor({ state: 'hidden' })
  await page.reload()
  await visit(title)
}
const route = async (section, label, model) => {
  const row = section
    .locator('fieldset')
    .filter({ has: page.locator('legend', { hasText: new RegExp(`^${label}$`) }) })
  await row.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('qualification')
  await row.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model)
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await visit('Model Links')
  const links = page.getByRole('region', { name: 'Linked model groups', exact: true })
  while (await links.getByRole('button', { name: 'Remove group', exact: true }).count())
    await links.getByRole('button', { name: 'Remove group', exact: true }).first().click()
  await links.getByRole('button', { name: 'Add link group', exact: true }).click()
  await route(links, 'Route 1', 'fixture')
  await route(links, 'Route 2', 'secondary')
  await save('Model Links')
  assert.equal(
    await links
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Route 2$/ }) })
      .getByRole('combobox', { name: 'Model', exact: true })
      .inputValue(),
    'secondary',
  )
  checks.push('Model link groups save and reload qualified routes')
  await page.screenshot({ path: `${directory}/model-links.png` })
  await visit('Fallback Router')
  const chains = page.getByRole('region', { name: 'Fallback chains', exact: true })
  while (await chains.getByRole('button', { name: 'Remove chain', exact: true }).count())
    await chains.getByRole('button', { name: 'Remove chain', exact: true }).first().click()
  await chains.getByRole('button', { name: 'Add fallback chain', exact: true }).click()
  await route(chains, 'Primary route', 'fixture')
  await route(chains, 'Fallback 1', 'secondary')
  await save('Fallback Router')
  assert.equal(
    await chains
      .locator('fieldset')
      .filter({ has: page.locator('legend', { hasText: /^Fallback 1$/ }) })
      .getByRole('combobox', { name: 'Model', exact: true })
      .inputValue(),
    'secondary',
  )
  checks.push('Primary and ordered fallback models save and reload')
  await page.screenshot({ path: `${directory}/fallback-router.png` })
  await visit('Decision Models')
  await page.locator('#llm-decision-models-backend').selectOption('registered')
  const model = page.locator('section[aria-label="Text model for decisions"]')
  await model.locator('select').nth(0).selectOption('qualification')
  await model.locator('select').nth(1).selectOption('fixture')
  await save('Decision Models')
  assert.equal(await page.locator('#llm-decision-models-backend').inputValue(), 'registered')
  checks.push('Decision backend and registered model save and reload')
  await page.screenshot({ path: `${directory}/decision-models.png` })
  await visit('Web Search')
  for (const name of ['Kagi', 'OpenRouter', 'Exa', 'ChatGPT Codex', 'OpenAI API'])
    assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 1)
  await page.getByText('No API-key fallback.', { exact: false }).waitFor()
  checks.push('Search fields are grouped into five providers with subscription account status')
  await page.screenshot({ path: `${directory}/web-search.png` })
} catch (error) {
  failures.push(error.message.replace(/token=[^\s"']+/g, '[redacted]'))
  await page.screenshot({ path: `${directory}/failure.png` })
} finally {
  await browser.close()
  const report = { checkedAt: new Date().toISOString(), checks, failures, paidInferenceCalls: 0 }
  await writeFile(`${directory}/qualification.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (failures.length) process.exitCode = 1
}
