/** Dispatch user-typed commands through the native composer, with a no-network model. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const directory = resolve('.qualification/command-browser'),
  log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape boundaries are deliberately excluded from the private startup URL.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw new Error('Start the packed fixture profile')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    headless: true,
    args: ['--no-sandbox'],
  }),
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  checks = [],
  failures = []
page.setDefaultTimeout(25000)
page.on('pageerror', (error) =>
  failures.push(error.message.replace(/token=[^\s"']+/g, '[redacted]')),
)
const editor = page.getByRole('textbox', {
  name: /Message or run a task|Describe what you want to build/,
})
async function command(text, kind = 'ok') {
  const previous = await page.locator('[data-variant="others"][data-state]').count()
  await page.waitForFunction(
    () =>
      document.querySelector('[data-composer-input=true]')?.getAttribute('contenteditable') ===
      'true',
  )
  await editor.fill(text)
  await editor.press('Enter')
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-variant="others"][data-state]').length > count,
    previous,
  )
  const card = page.locator('[data-variant="others"][data-state]').nth(previous)
  await page.waitForFunction((index) => {
    const card = document.querySelectorAll('[data-variant="others"][data-state]')[index]
    return card && card.getAttribute('data-state') !== 'running'
  }, previous)
  const state = await card.getAttribute('data-state')
  if (state !== kind)
    throw new Error(
      `${text.split(' ')[0]} returned ${state}: ${(await card.innerText()).slice(0, 600)}`,
    )
  checks.push({ command: text.split(' ')[0], state })
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: 'Local qualification model', exact: true }).click()
  await page.getByRole('button', { name: 'Session tools', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Workspace & checkpoints', exact: true }).click()
  await page.getByRole('button', { name: 'Start isolated work session', exact: true }).click()
  await page.waitForTimeout(1200)
  const close = page.getByRole('button', { name: 'Close session tools', exact: true })
  if (await close.isVisible()) await close.click()
  await editor.fill('Start the controlled command qualification. Do not publish anything.')
  await editor.press('Enter')
  await page
    .getByText('Controlled local qualification completed. No external provider was contacted.', {
      exact: true,
    })
    .last()
    .waitFor()
  for (const text of [
    '/model-links',
    '/codex-usage status',
    '/codex-accounts',
    '/codex-status',
    '/zai-status',
    '/decision status',
    '/runs list',
    '/policy',
    '/environment status',
    '/secrets',
    '/assurance status',
    '/workspace status',
    '/checkpoint list',
    '/glob status',
    '/glob preview *.md',
    '/summary status',
    '/agents-file status',
    '/system-prompt',
    '/goal-list',
    '/goal-status',
  ])
    await command(text)
  await command('/decision Choose a test result :: yes | no :: fixture')
  await command('/workflow status', 'error')
  await command('/model-link qualification/fixture=qualification/secondary')
  await command('/model-cycle')
  await page.getByRole('button', { name: /Select model, current.*Local secondary model/ }).waitFor()
  await command('/model-cycle')
  await page
    .getByRole('button', { name: /Select model, current.*Local qualification model/ })
    .waitFor()
  await command('/model-unlink qualification/secondary')
  await command('/model-link missing', 'error')
  await command('/codex-use account-does-not-exist', 'error')
  await command('/glob preview ../*', 'error')
  await command('/goal-start missing 1', 'error')
  await command('/goal Review the native goal proposal')
  await page.getByText('Which completion checks should the goal use?', { exact: true }).waitFor()
  await page.getByText('Tests and review', { exact: true }).first().click()
  const submit = page.getByRole('button', { name: 'Submit', exact: true })
  if (await submit.isVisible()) await submit.click()
  await page.getByRole('button', { name: 'Session tools', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Plan & goals', exact: true }).click()
  await page.getByRole('heading', { name: 'Review goal proposal', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm and start goal', exact: true }).waitFor()
  await page.screenshot({ path: join(directory, 'goal-proposal-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(directory, 'goal-proposal-mobile.png') })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await command('/goal-cancel')
  checks.push({ goalProposalRequiresHumanConfirmation: true })
  await page.screenshot({ path: join(directory, 'commands.png') })
} catch (error) {
  failures.push(error.message.replace(/token=[^\s"']+/g, '[redacted]'))
  await page.screenshot({ path: join(directory, 'failure.png') })
} finally {
  await browser.close()
  const report = { checkedAt: new Date().toISOString(), checks, failures, paidInferenceCalls: 0 }
  await writeFile(join(directory, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
  if (failures.length) process.exitCode = 1
}
