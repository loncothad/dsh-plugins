/** Public artifact downloads pin validated DNS answers while retaining the original TLS identity. */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import {
  Agent,
  buildConnector,
  type RequestInit as UndiciRequestInit,
  fetch as undiciFetch,
} from 'undici'

export function publicArtifactUrl(value: string): URL {
  const url = new URL(value),
    host = url.hostname.replace(/^\[|\]$/g, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (isIP(host) && ipaddr.process(host).range() !== 'unicast')
  )
    throw new Error('Generated artifacts require credential-free public HTTPS destinations')
  return url
}
const connect = buildConnector({ rejectUnauthorized: true, timeout: 10000 })
const dispatcher = new Agent({
  maxOrigins: 128,
  connections: 4,
  keepAliveTimeout: 10000,
  connect(options, callback) {
    const host = options.hostname.replace(/^\[|\]$/g, '')
    void (
      isIP(host)
        ? Promise.resolve([{ address: host, family: isIP(host) }])
        : lookup(host, { all: true, verbatim: true })
    ).then(
      (addresses) => {
        if (
          !addresses.length ||
          addresses.length > 64 ||
          addresses.some((row) => ipaddr.process(row.address).range() !== 'unicast')
        ) {
          callback(new Error('Artifact DNS resolved to a non-public address'), null)
          return
        }
        let index = 0
        const attempt = () =>
          connect(
            {
              ...options,
              hostname: addresses[index]!.address,
              servername: options.servername ?? host,
            },
            (error, socket) => {
              if (error && ++index < addresses.length) attempt()
              else if (error) callback(error, null)
              else callback(null, socket!)
            },
          )
        attempt()
      },
      (error) => callback(error instanceof Error ? error : new Error('Artifact DNS failed'), null),
    )
  },
})
export function publicArtifactFetch(url: string, init: RequestInit): Promise<Response> {
  publicArtifactUrl(url)
  const request = { ...init, dispatcher, redirect: 'error' as const, credentials: 'omit' as const }
  return undiciFetch(url, request as UndiciRequestInit) as Promise<Response>
}
