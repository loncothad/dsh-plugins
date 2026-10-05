/** Opt-in public registry check. No credentials, installs, scripts, or registry writes. */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const packages = []
for (const group of ['plugins', 'support'])
  for (const entry of await readdir(resolve(root, group)))
    packages.push(JSON.parse(await readFile(resolve(root, group, entry, 'package.json'), 'utf8')))
const owned = new Set(packages.map((item) => item.name)),
  peers = new Map()
for (const manifest of packages)
  for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
    if (owned.has(name)) continue
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
      throw new Error(`Peer ${name} must have an exact registry version`)
    const key = `${name}@${version}`
    peers.set(key, { name, version })
  }
const queue = [...peers.values()],
  verified = [],
  failures = []
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const peer = queue.shift()
      if (!peer) return
      try {
        const response = await fetch(
          `https://registry.npmjs.org/${encodeURIComponent(peer.name)}/${encodeURIComponent(peer.version)}`,
          {
            redirect: 'error',
            credentials: 'omit',
            signal: AbortSignal.timeout(20000),
            headers: { accept: 'application/json' },
          },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const metadata = await response.json()
        if (
          metadata.name !== peer.name ||
          metadata.version !== peer.version ||
          !/^sha512-/.test(metadata.dist?.integrity ?? '') ||
          !metadata.dist?.tarball?.startsWith('https://registry.npmjs.org/')
        )
          throw new Error('Invalid registry metadata')
        verified.push({
          ...peer,
          integrity: metadata.dist.integrity,
          tarball: metadata.dist.tarball,
          gitHead: metadata.gitHead ?? null,
        })
      } catch (error) {
        failures.push({ ...peer, error: error instanceof Error ? error.message : 'Request failed' })
      }
    }
  }),
)
verified.sort((a, b) => a.name.localeCompare(b.name))
failures.sort((a, b) => a.name.localeCompare(b.name))
const report = { checkedAt: new Date().toISOString(), verified, failures }
if (process.argv[2])
  await writeFile(resolve(process.argv[2]), `${JSON.stringify(report, null, 2)}\n`)
for (const failure of failures)
  console.error(`${failure.name}@${failure.version}: ${failure.error}`)
console.log(`Registry peers: ${verified.length} available, ${failures.length} failed`)
if (failures.length) process.exitCode = 1
