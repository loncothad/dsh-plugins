/** Verify native context disclosures and unchanged human bubbles for automatic expansions. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Exclude terminal escape boundaries from the private startup URL.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
assert.ok(url)
const directory = '.qualification/globs-refine'
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
try {
  await page.goto(url)
  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: 'Local qualification model', exact: true }).click()
  const original = 'Inspect *.md and keep publication pending.'
  const editor = page.getByRole('textbox', {
    name: /Message or run a task|Describe what you want to build/,
  })
  await editor.fill(original)
  await editor.press('Enter')
  await page
    .getByText('Controlled local qualification completed. No external provider was contacted.', {
      exact: true,
    })
    .last()
    .waitFor()
  await page.getByText(original, { exact: true }).waitFor()
  const card = page.getByRole('region', { name: 'Glob expansion applied', exact: true })
  await card.waitFor()
  const requestBounds = await page.getByText(original, { exact: true }).boundingBox(),
    globBounds = await card.boundingBox(),
    responseBounds = await page
      .getByText('Controlled local qualification completed. No external provider was contacted.', {
        exact: true,
      })
      .last()
      .boundingBox()
  assert.ok(
    requestBounds &&
      globBounds &&
      responseBounds &&
      globBounds.y >= requestBounds.y &&
      globBounds.y < responseBounds.y,
    'Glob disclosure must follow the user and precede the assistant',
  )
  checks.push(
    'Activation badge and file disclosure appear after the user request, before the assistant answer',
  )
  const row = card.locator('summary').first()
  assert.equal(await card.locator('details').first().getAttribute('open'), null)
  assert.equal(
    await page.getByText('Observed file-list snapshot.', { exact: false }).isVisible(),
    false,
  )
  checks.push(
    'Original human message remains unchanged; the expansion is a separate collapsed native context row',
  )
  await page.screenshot({ path: `${directory}/chat-collapsed-desktop.png` })
  await row.focus()
  await page.keyboard.press('Enter')
  await page.getByText('Observed file-list snapshot.', { exact: false }).waitFor()
  await page.getByText('accepted.md', { exact: false }).waitFor()
  checks.push('Keyboard expansion reveals the complete model-visible file list')
  await page.screenshot({ path: `${directory}/chat-expanded-desktop.png` })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: `${directory}/chat-expanded-mobile.png` })
  const fits = await row.evaluate((node) => node.getBoundingClientRect().right <= innerWidth + 2)
  assert.ok(fits)
  checks.push('Native disclosure fits the mobile viewport')
  await page.reload()
  await card.waitFor()
  await page.getByText(original, { exact: true }).waitFor()
  checks.push('Native replay retains the original message and collapsed expansion')
} catch (error) {
  failures.push(error.message.replace(/token=[^\s"']+/g, '[redacted]'))
  await page.screenshot({ path: `${directory}/failure.png` })
} finally {
  await browser.close()
  const report = { checkedAt: new Date().toISOString(), checks, failures, inferenceCalls: 0 }
  await writeFile(`${directory}/qualification.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (failures.length) process.exitCode = 1
}
