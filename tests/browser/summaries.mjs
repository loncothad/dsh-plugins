/** Native presentation-only summary cards and context inspection. Requires the no-network browser fixture. */

import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const log = await fixtureLog(),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Deliberate control-character filtering at an input or log boundary.
  url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw new Error('Start the private qualification profile')
const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox'],
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  failures = [],
  directory = resolve('.qualification/browser-results')
let readerCtx
page.setDefaultTimeout(20000)
const openPanel = async (label) => {
  const close = page.getByRole('button', { name: 'Close session tools', exact: true })
  if (await close.isVisible()) await close.click()
  await page.getByRole('button', { name: 'Session tools', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await page.getByRole('dialog', { name: label, exact: true }).waitFor()
}
const clean = (value) => String(value).replace(/token=[^\s"']+/g, 'token=[redacted]')
page.on('pageerror', (error) => failures.push(clean(error.message)))
page.on('console', (message) => {
  if (message.text().match(/Private state read failed|PrivateStateObservation/))
    console.log(clean(message.text()).slice(0, 2000))
})
try {
  await mkdir(directory, { recursive: true })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByText('Conversation Summaries', { exact: true }).first().click()
  await page.locator('form').waitFor()
  const section = page.locator('section[aria-label="Summary model"]')
  await section.locator('select').nth(0).selectOption('qualification')
  await section.locator('select').nth(1).selectOption('fixture')
  await page.locator('#conversation-summary-generation').selectOption('model')
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.waitForTimeout(1500)
  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: 'Local qualification model', exact: true }).click()
  const editor = page.getByRole('textbox', {
    name: /Message or run a task|Describe what you want to build/,
  })
  await editor.fill(
    'Inspect the configuration and preserve the constraint: publication remains pending.',
  )
  await editor.press('Enter')
  await page
    .getByText('Controlled local qualification completed. No external provider was contacted.', {
      exact: true,
    })
    .last()
    .waitFor()
  await page.waitForTimeout(750)
  await openPanel('Summaries')
  await page.getByRole('button', { name: 'Summarize recent progress', exact: true }).click()
  const card = page.getByRole('article', { name: 'Conversation summary', exact: true })
  await card.waitFor()
  await card.getByText('Read summary', { exact: true }).click()
  await card.getByText('Human-only fixture summary:', { exact: false }).waitFor()
  checks.push(
    'External-model summary renders through the authenticated private-content service in a native conversation card',
  )
  if (
    !(await card
      .getByText('Visible to you. Excluded from the main model context and compaction.', {
        exact: true,
      })
      .count())
  )
    throw new Error('Summary visibility boundary is not explained')
  await page.screenshot({ path: join(directory, 'summary-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'summary-mobile.png') })
  const bounds = await card.boundingBox()
  if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 390)
    throw new Error('Summary card exceeds the mobile viewport')
  checks.push(
    'Summary card, coverage, origin and privacy explanation fit desktop and mobile layouts',
  )
  await page.setViewportSize({ width: 1440, height: 1000 })
  await openPanel('Context inspector')
  await page.getByRole('button', { name: 'Inspect current context', exact: true }).click()
  const view = page.getByRole('region', { name: 'Current model context', exact: true })
  await view.waitFor()
  if ((await view.innerText()).includes('Human-only fixture summary:'))
    throw new Error('Private summary text appeared in the request inspector')
  await page.screenshot({ path: join(directory, 'context-inspector.png') })
  checks.push(
    'Native Context Inspector shows the main-agent request independently of auxiliary summary generation',
  )
  await page.getByRole('button', { name: 'Close session tools', exact: true }).click()
  await editor.fill('Continue the task while retaining the publication constraint.')
  await editor.press('Enter')
  await page.waitForTimeout(1000)
  const profile = {
      profile: resolve(process.env.DSH_TEST_PROFILE),
      home: resolve(process.env.DSH_TEST_PROFILE, '../..'),
    },
    logs = []
  const require = createRequire(join(profile.profile, 'package.json')),
    load = async (name) => import(pathToFileURL(require.resolve(name)).href),
    { Context } = await load('@deepseek-ai/cordis'),
    { default: Persistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
  readerCtx = new Context()
  const reader = new Persistence(readerCtx, {
    root: join(profile.home, 'sessions'),
    compression: 'zstd',
  })
  const walk = async (path) => {
    for (const row of await readdir(path, { withFileTypes: true })) {
      const child = join(path, row.name)
      if (row.isDirectory()) await walk(child)
      else if (row.name.endsWith('.jsonl.zstd'))
        logs.push(
          JSON.stringify((await reader.readStoredLog(child, basename(dirname(child)))).events),
        )
    }
  }
  await walk(join(profile.home, 'sessions'))
  if (
    logs.some(
      (text) =>
        text.includes('conversation-summary/delivered') || text.includes('plan-goals/change'),
    )
  )
    throw new Error('Plugin metadata polluted the native session vocabulary')
  if (logs.some((text) => text.includes('Human-only fixture summary:')))
    throw new Error('Private summary body appeared in the original session log')
  checks.push(
    'Native persistence reads every current session; plugin metadata and external summary bodies are absent from the original logs',
  )
  await openPanel('Summaries')
  await page.getByRole('button', { name: 'Summarize recent progress', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('article[aria-label="Conversation summary"]').length >= 2,
    {},
    { timeout: 15000 },
  )
  if ((await page.getByRole('article', { name: 'Conversation summary', exact: true }).count()) < 2)
    throw new Error('Incremental second card did not render')
  checks.push('A second on-demand summary covers only new conversation progress')
} catch (error) {
  failures.push(clean(error.message))
  await page.screenshot({ path: join(directory, 'summary-failure.png') })
} finally {
  await readerCtx?.fiber.dispose()
  await browser.close()
  const report = {
    checkedAt: new Date().toISOString(),
    checks,
    failures,
    fixture:
      'No-network registered model; actual native host jobs, private journal and Gateway UI.',
  }
  await writeFile(
    join(directory, 'summary-qualification.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
  if (failures.length) process.exitCode = 1
}
