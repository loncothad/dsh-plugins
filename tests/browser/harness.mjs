/** Browser checks may mutate only a marked fixture profile, never the interactive profile. */
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export async function fixtureLog(input = {}) {
  const profile = input.profile ?? process.env.DSH_TEST_PROFILE,
    log = input.log ?? process.env.DSH_QUALIFICATION_WEB_LOG
  if (!profile || !log)
    throw Error(
      'Set DSH_TEST_PROFILE and DSH_QUALIFICATION_WEB_LOG for a temporary fixture profile',
    )
  const directory = await realpath(profile),
    marker = JSON.parse(await readFile(join(directory, '.dsh-browser-fixture.json'), 'utf8')),
    metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (
    marker.version !== 1 ||
    resolve(marker.profile) !== directory ||
    !metadata.dsh?.profile?.bundles?.includes('qualification-fixture')
  )
    throw Error('The selected profile is not a marked browser fixture')
  const logPath = await realpath(log),
    withinHome = relative(resolve(directory, '../..'), logPath)
  if (withinHome.startsWith('..') || isAbsolute(withinHome))
    throw Error('The startup log must belong to the selected fixture home')
  return readFile(logPath, 'utf8')
}
