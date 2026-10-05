/** Provider request identity follows pi-ai at a276dabe57911253350bffb93cb7d7aff6a73261.
 * Adapted from its MIT-licensed pi-user-agent.ts; see THIRD_PARTY_NOTICES.txt.
 */
import type * as NodeOs from 'node:os'

function loadOs(): typeof NodeOs | undefined {
  if (typeof process === 'undefined' || !(process.versions?.node || process.versions?.bun))
    return undefined
  return process.getBuiltinModule?.('node:os') as typeof NodeOs | undefined
}

/** pi's provider identity, derived from the current host rather than a CLI release. */
export function getPiUserAgent(): string {
  const os = loadOs()
  return os ? `pi (${os.platform()} ${os.release()}; ${os.arch()})` : 'pi (browser)'
}

/** pi's Codex operation and browser-authorization originator. */
export const PI_ORIGINATOR = 'pi'
