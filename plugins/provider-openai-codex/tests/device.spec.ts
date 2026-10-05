import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deviceLogin } from '../src/device.ts'
import { makePkce } from '../src/oauth.ts'

describe('Codex device authorization', () => {
  it('displays the user code, waits through pending responses, and exchanges the issued verifier', async () => {
    const calls: { url: string; body: string }[] = []
    const notices: { code: string; url: string }[] = []
    const bodies = [
      new Response(
        JSON.stringify({ device_auth_id: 'device-1', user_code: 'ABCD-EFGH', interval: '1' }),
      ),
      new Response('', { status: 403 }),
      new Response(
        JSON.stringify({ authorization_code: 'approved', code_verifier: 'server-verifier' }),
      ),
      new Response(
        JSON.stringify({
          access_token: 'test-access',
          refresh_token: 'test-refresh',
          expires_in: 3600,
        }),
      ),
    ]
    let sleeps = 0
    const tokens = await deviceLogin({
      signal: new AbortController().signal,
      notify: (notice) => {
        notices.push(notice)
      },
      sleep: async () => {
        sleeps++
      },
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) })
        return bodies.shift()!
      },
    })
    expect(notices).toMatchObject([
      { code: 'ABCD-EFGH', url: 'https://auth.openai.com/codex/device' },
    ])
    expect(sleeps).toBe(1)
    expect(calls[0]?.url).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode')
    const exchanged = new URLSearchParams(calls.at(-1)?.body)
    expect(exchanged.get('code_verifier')).toBe('server-verifier')
    expect(exchanged.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
    expect(tokens.accessToken).toBe('test-access')
  })

  it('stops polling when cancelled', async () => {
    const abort = new AbortController()
    let calls = 0
    await expect(
      deviceLogin({
        signal: abort.signal,
        notify: () => {},
        fetch: async () => {
          calls++
          return calls === 1
            ? new Response(JSON.stringify({ device_auth_id: 'd', user_code: 'c' }))
            : new Response('', { status: 404 })
        },
        sleep: async () => {
          abort.abort(new Error('cancelled'))
        },
      }),
    ).rejects.toThrow('cancelled')
    expect(calls).toBe(2)
  })

  it('produces RFC 7636 URL-safe verifier material', async () => {
    const material = await makePkce(
      () => 255 / 256,
      async (input) => createHash('sha256').update(input).digest('base64url'),
    )
    expect(material.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(material.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(material.challenge).toBe(
      createHash('sha256').update(material.verifier).digest('base64url'),
    )
  })
})
