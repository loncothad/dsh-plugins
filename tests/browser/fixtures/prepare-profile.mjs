/** Create an empty, isolated fixture home from packed artifacts. Never copies accounts or credentials. */
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.argv.length !== 4)
  throw Error('Usage: node tests/browser/fixtures/prepare-profile.mjs ARTIFACTS EMPTY_TEST_ROOT')
const artifacts = resolve(process.argv[2]),
  root = resolve(process.argv[3]),
  home = join(root, 'dev'),
  profile = join(home, 'profiles/web'),
  workspace = join(root, 'workspace'),
  repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
await mkdir(root, { recursive: true, mode: 0o700 })
if ((await readdir(root)).length) throw Error('The test root must be empty')
const prepared = spawnSync(
  process.execPath,
  [join(repo, 'tools/release/prepare-consumer.mjs'), artifacts, profile],
  { encoding: 'utf8' },
)
if (prepared.status !== 0) throw Error(prepared.stderr || 'Could not prepare packed dependencies')
const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
manifest.dependencies['@deepseek-ai/dsh'] = '0.2.0-rc.2'
manifest.dependencies['@deepseek-ai/dsh-base'] = '0.2.0-rc.2'
manifest.dependencies['@deepseek-ai/dsh-web-app'] = '0.2.0-rc.2'
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
for (const dir of await readdir(join(repo, 'plugins')))
  bundles.push(JSON.parse(await readFile(join(repo, 'plugins', dir, 'package.json'), 'utf8')).name)
manifest.dsh = { profile: { bundles } }
await writeFile(join(profile, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
})
await writeFile(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600 })
await mkdir(workspace, { recursive: true })
await writeFile(join(workspace, 'README.md'), '# Local fixture\nDo not publish this fixture.\n')
const init = spawnSync('git', ['init', '--initial-branch=main', workspace], { encoding: 'utf8' })
if (init.status !== 0) throw Error('Install Git before preparing browser fixtures')
for (const args of [
  ['add', '.'],
  [
    '-c',
    'user.name=DSH fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture',
  ],
]) {
  if (spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).status !== 0)
    throw Error('Could not initialize the fixture repository')
}
const entry = (id, config) => `- id: ${id}\n  config: ${JSON.stringify(config)}\n`
const patch =
  entry('ui-settings-general', { welcomeNoticeVersion: '2026-09-28.1' }) +
  entry('agent-default-model', { provider: 'qualification', model: 'fixture' }) +
  entry('environment-isolation', { environment: 'dev', rootDirectory: root, allowShell: true }) +
  entry('execution-recovery', { dataDir: join(home, 'execution') }) +
  entry('workspace-safety', { repositories: { project: workspace } }) +
  entry('qualification-fixture', { workspace }) +
  entry('conversation-summary', {
    generation: 'model',
    summaryProvider: 'qualification',
    summaryModel: 'fixture',
  })
await writeFile(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 })
await writeFile(
  join(root, 'fixture.json'),
  `${JSON.stringify({ home, profile, workspace }, null, 2)}\n`,
  { mode: 0o600 },
)
console.log(
  `Prepared empty fixture at ${profile}. Install its dependencies, then install the local fixture bundle.`,
)
