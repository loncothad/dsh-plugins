/** Inspect and save the packed glob configuration without sending any model request. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const directory = resolve('.qualification/globs-ui')
const log = await fixtureLog()
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal separators from the private launch URL.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw new Error('Start the private qualification profile')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(20000)
const checks = []
const failures = []
page.on('pageerror', (error) =>
  failures.push(error.message.replace(/token=[^\s"']+/g, '[redacted]')),
)
const visit = async () => {
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByText('Path Globs', { exact: true }).first().click()
  await page.locator('form').waitFor()
  await page.locator('#path-globs-additionalIgnoreFiles').waitFor()
  await page.waitForTimeout(1200)
}
const save = async () => {
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.getByText('Configuration saved.', { exact: true }).waitFor()
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  await visit()
  await page.locator('#path-globs-honorIgnoreFiles').selectOption('false')
  await page.locator('#path-globs-respectGitignore').selectOption('false')
  await page.locator('#path-globs-respectIgnore').selectOption('true')
  await page.locator('#path-globs-additionalIgnoreFiles').fill('.dshignore\n.customignore')
  await save()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await visit()
  for (const [key, value] of Object.entries({
    honorIgnoreFiles: 'false',
    respectGitignore: 'false',
    respectIgnore: 'true',
    additionalIgnoreFiles: '.dshignore\n.customignore',
  })) {
    if ((await page.locator(`#path-globs-${key}`).inputValue()) !== value)
      throw new Error(`Save/reload lost ${key}`)
  }
  checks.push(
    'Master switch, independent built-in switches and custom filenames survive save/reload',
  )
  await page.locator('#path-globs-additionalIgnoreFiles').fill('../.ignore')
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click()
  await page.locator('.config-status').waitFor()
  if ((await page.locator('.config-status').allTextContents()).includes('Configuration saved.'))
    throw new Error('An escaping ignore filename was saved')
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click()
  if (
    (await page.locator('#path-globs-additionalIgnoreFiles').inputValue()) !==
    '.dshignore\n.customignore'
  )
    throw new Error('Discard failed to restore custom filenames')
  checks.push('Schema validation rejects saving invalid filenames; discard restores the saved list')
  for (const [key, value] of Object.entries({ honorIgnoreFiles: 'true', respectGitignore: 'true' }))
    await page.locator(`#path-globs-${key}`).selectOption(value)
  await page.locator('#path-globs-additionalIgnoreFiles').fill('')
  await save()
  await page.locator('#path-globs-honorIgnoreFiles').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(directory, 'ignore-settings-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(250)
  const width = await page.locator('form').evaluate((form) => [form.clientWidth, form.scrollWidth])
  if (width[1] > width[0] + 2)
    throw new Error(`Glob settings overflow the mobile viewport (${width[1]}/${width[0]})`)
  await page.screenshot({ path: join(directory, 'ignore-settings-mobile.png') })
  checks.push('Native configuration controls fit desktop and mobile widths')
} catch (error) {
  failures.push(error.message.replace(/token=[^\s"']+/g, '[redacted]'))
  await page.screenshot({ path: join(directory, 'failure.png') })
} finally {
  await browser.close()
  const report = { checkedAt: new Date().toISOString(), checks, failures, paidInferenceCalls: 0 }
  await writeFile(join(directory, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (failures.length) process.exitCode = 1
}
