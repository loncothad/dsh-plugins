import { expect, it } from 'vitest'
import { publicArtifactUrl } from '../src/network.ts'

it('rejects loopback, private, link-local, mapped IPv6 and credentialed artifact URLs', () => {
  for (const url of [
    'http://cdn.example/image.png',
    'https://localhost/image',
    'https://127.0.0.1/image',
    'https://2130706433/image',
    'https://10.0.0.1/image',
    'https://169.254.169.254/image',
    'https://[::1]/image',
    'https://[::ffff:127.0.0.1]/image',
    'https://[fd00::1]/image',
    'https://user:secret@cdn.example/image',
  ])
    expect(() => publicArtifactUrl(url)).toThrow()
  expect(publicArtifactUrl('https://cdn.example/image.png').hostname).toBe('cdn.example')
})
