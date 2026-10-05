import { arch, platform, release } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { getPiUserAgent, PI_ORIGINATOR } from '../src/request-identity.ts'

afterEach(() => vi.unstubAllGlobals())

it('uses the pi-ai provider identity without a Codex CLI version or account data', () => {
  expect(getPiUserAgent()).toBe(`pi (${platform()} ${release()}; ${arch()})`)
  expect(PI_ORIGINATOR).toBe('pi')
})

it('has a browser-safe identity when OS builtins are unavailable', () => {
  vi.stubGlobal('process', undefined)
  expect(getPiUserAgent()).toBe('pi (browser)')
  vi.stubGlobal('process', { versions: { node: '24.0.0' } })
  expect(getPiUserAgent()).toBe('pi (browser)')
})
