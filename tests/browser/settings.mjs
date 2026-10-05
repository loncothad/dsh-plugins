/** Check every owned plugin page with empty credentials; no model requests or sign-in. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { fixtureLog } from './harness.mjs'

const log = await fixtureLog(),
  directory = resolve('.qualification/browser/settings')
// biome-ignore lint/suspicious/noControlCharactersInRegex: Private startup URLs exclude terminal control sequences.
const url = log.match(/http:\/\/127\.0\.0\.1:[0-9]+\/[^\s\x1b]*/)?.[0]
if (!url) throw Error('Start the marked fixture profile')
const titles = []
for (const dir of await readdir('plugins')) {
  const manifest = JSON.parse(await readFile(join('plugins', dir, 'package.json'), 'utf8'))
  if (!manifest.dsh?.client) continue
  const locale = JSON.parse(await readFile(join('plugins', dir, 'locale/en.json'), 'utf8'))
  titles.push({ title: locale.meta.title, custom: dir === 'builtin-controls' })
}
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
const clean = (text) => text.replace(/token=[^\s"']+/g, 'token=[redacted]')
page.on('pageerror', (e) => failures.push(clean(e.message)))
try {
  await page.goto(url)
  for (const { title, custom } of titles) {
    await page.getByRole('button', { name: 'Plugins', exact: true }).click()
    const back = page.getByRole('button', { name: 'Back to plugins', exact: true })
    if (await back.count()) await back.click()
    await page.getByText(title, { exact: true }).first().click()
    if (custom) await page.getByRole('region', { name: 'Built-in controls', exact: true }).waitFor()
    else await page.locator('form').waitFor()
    const count = await page.locator('form').count()
    if (count !== (custom ? 0 : 1))
      throw Error(`${title}: unexpected configuration form count ${count}`)
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const colorScheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme })
        await page.waitForTimeout(400)
        const panel = custom ? page.locator('.dsh-builtin-controls') : page.locator('form')
        if (await panel.evaluate((node) => node.scrollWidth > node.clientWidth + 2))
          throw Error(`${title}: horizontal overflow at ${width}px in ${colorScheme}`)
        await page.screenshot({
          path: join(directory, `${title.replace(/[^a-z0-9]/gi, '-')}-${width}-${colorScheme}.png`),
        })
      }
    }
    checks.push({ title, widths: [1440, 390], themes: ['light', 'dark'] })
    await page.setViewportSize({ width: 1440, height: 1000 })
  }
} catch (e) {
  failures.push(clean(e.message))
} finally {
  await browser.close()
  const report = { checkedAt: new Date().toISOString(), checks, failures, paidInferenceCalls: 0 }
  await writeFile(join(directory, 'qualification.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (failures.length) process.exitCode = 1
}
