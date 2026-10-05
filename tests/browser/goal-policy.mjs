/** Goal presentation and scoped human approvals against installed packages and a no-network fixture. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const out = resolve('.qualification/goal-policy-browser'),
  log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Private startup URL excludes terminal control sequences.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw Error('Start the packed no-network fixture profile')
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
const editor = page.locator('[data-composer-input=true]'),
  card = page.locator('.dsh-goal-progress-shell .dsh-goal-progress')
const send = async (text) => {
  await page.waitForFunction(
    () =>
      document.querySelector('[data-composer-input=true]')?.getAttribute('contenteditable') ===
      'true',
  )
  await editor.fill(text)
  await editor.press('Enter')
}
const panel = async (label) => {
  await page.getByRole('button', { name: 'Session tools', exact: true }).click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await page.getByRole('dialog', { name: label, exact: true }).waitFor()
}
const close = async () => {
  await page.getByRole('button', { name: 'Close session tools', exact: true }).click()
}
async function geometry(name) {
  const result = await page.evaluate(() => {
    const progress = document.querySelector('.dsh-goal-progress-shell .dsh-goal-progress'),
      input = document.querySelector('[data-composer-input=true]')
    let composer = input
    while (composer && getComputedStyle(composer).borderRadius === '0px')
      composer = composer.parentElement
    const p = progress.getBoundingClientRect(),
      c = composer.getBoundingClientRect(),
      s = document.querySelector('.dsh-goal-progress-summary'),
      padding = getComputedStyle(s)
    return {
      left: p.left,
      composerLeft: c.left,
      width: p.width,
      composerWidth: c.width,
      padding: parseFloat(padding.paddingLeft),
      overflow: progress.scrollWidth > progress.clientWidth + 2,
    }
  })
  if (
    Math.abs(result.left - result.composerLeft) > 2 ||
    Math.abs(result.width - result.composerWidth) > 2 ||
    result.padding < 10 ||
    result.overflow
  )
    throw Error(`${name} composer alignment: ${JSON.stringify(result)}`)
  checks.push({ layout: name, ...result })
  await page.screenshot({ path: join(out, `${name}.png`) })
}
try {
  await page.goto(url)
  await page.waitForTimeout(1400)
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const back = page.getByRole('button', { name: 'Back to plugins', exact: true })
  if (await back.count()) await back.click()
  await page.getByText('Environment Isolation', { exact: true }).first().click()
  await page.locator('#environment-isolation-allowShell').selectOption('true')
  if (await page.getByRole('button', { name: 'Save configuration', exact: true }).isEnabled())
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.waitForTimeout(1300)

  await page
    .getByRole('button', { name: /^New Session$/i })
    .last()
    .click()
  await page.getByRole('button', { name: /Select model, current/ }).click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio', { name: 'Local qualification model', exact: true }).click()
  if (await card.count()) throw Error('Empty chat displays a phantom goal')
  checks.push('No goal leaves no progress box')
  await send('/goal Qualify the aligned rich goal progress panel without publishing anything')
  await page.getByText('Which completion checks should the goal use?', { exact: true }).waitFor()
  await card.getByText('Planning', { exact: true }).waitFor({ state: 'attached' })
  if (
    (await card.locator('progress').count()) ||
    (await card.locator('.dsh-goal-progress-count').count())
  )
    throw Error('Planning displays an empty task denominator')
  await page.getByRole('region', { name: 'Goal planning request', exact: true }).waitFor()
  if ((await page.locator('body').innerText()).includes('Help me plan this regular goal'))
    throw Error('Internal planning instructions rendered as human text')
  checks.push('Planning request uses its own card; planning has no 0/0 or empty meter')
  await page.screenshot({ path: join(out, 'planning-desktop.png') })
  await page.getByText('Tests and review', { exact: true }).first().click()
  const submit = page.getByRole('button', { name: 'Submit', exact: true })
  if (await submit.isVisible()) await submit.click()
  await card.getByText('Awaiting review', { exact: true }).waitFor()
  await geometry('proposal-desktop')
  await card.locator('summary').first().focus()
  await page.keyboard.press('Space')
  await card.getByRole('button', { name: 'Review proposal', exact: true }).waitFor()
  checks.push('Keyboard expands the full proposal controls')
  const collapse = page.getByRole('button', { name: 'Collapse sidebar', exact: true })
  if (await collapse.isVisible()) await collapse.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(350)
  await geometry('proposal-mobile')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(200)
  await geometry('proposal-mobile-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  if (await card.locator('progress').count())
    throw Error('Proposal shows task execution progress before approval')
  await card.getByRole('button', { name: 'Review proposal', exact: true }).click()
  await page.getByRole('heading', { name: 'Review goal proposal', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm and start goal', exact: true }).waitFor()
  checks.push('Proposal opens the full review panel through the public panel API')
  await close()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await send('/goal-cancel')
  await page.waitForTimeout(1700)
  if (await card.count()) throw Error('Cancelled planning leaves a progress box')
  checks.push('Cancelled planning clears the box')
  await send('Policy qualification step 1')
  const approval = page.getByRole('region', { name: 'Review policy action', exact: true })
  await approval.waitFor()
  await approval
    .getByRole('button', { name: 'Approve similar', exact: true })
    .waitFor({ state: 'visible' })
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.dsh-policy-review button')].some(
      (b) => b.textContent === 'Approve similar' && !b.disabled,
    ),
  )
  await page.screenshot({ path: join(out, 'approve-similar.png') })
  await approval.getByRole('button', { name: 'Approve similar', exact: true }).click()
  await page.getByText('Policy fixture 1 finished.', { exact: true }).last().waitFor()
  if ((await page.locator('body').innerText()).includes('cannot get property "sandbox"'))
    throw Error('Shell execution still lacks sandbox injection')
  checks.push('Human Approve similar completes the native policy waterfall and sandboxed Bash')
  await send('Policy qualification step 2')
  await page.getByText('Policy fixture 2 finished.', { exact: true }).last().waitFor()
  if (await approval.count()) throw Error('Exact approved repeat still prompts')
  checks.push('Approved repeat runs without another policy warning')
  await panel('Policy permissions')
  await page.getByRole('button', { name: 'Revoke', exact: true }).click()
  await page.getByText('No remembered approvals in this chat.', { exact: true }).waitFor()
  await close()
  await send('Policy qualification step 3')
  await approval.waitFor()
  await approval.locator('[tabindex="0"]').focus()
  await page.keyboard.press('Escape')
  await page.getByText('Policy fixture 3 rejected.', { exact: true }).last().waitFor()
  checks.push('Revoke restores review; Escape rejects the next action')
  await send('Policy qualification step 4')
  await approval.waitFor()
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
  await page.getByText('Policy fixture 4 finished.', { exact: true }).last().waitFor()
  await panel('Policy permissions')
  await page.getByText('No remembered approvals in this chat.', { exact: true }).waitFor()
  await close()
  checks.push('Allow once creates no saved permission')
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
