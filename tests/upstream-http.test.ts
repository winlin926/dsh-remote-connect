import { describe, expect, it } from 'vitest'
import { REMOTE_MARK, upstreamRequestHeaders } from '../src/upstream-http.js'

describe('upstreamRequestHeaders', () => {
  it('keeps ordinary headers and arrays, then injects the loopback envelope', () => {
    const headers = upstreamRequestHeaders({
      headers: {
        host: 'desktop.example.com',
        cookie: 'remote-device=1',
        authorization: 'Bearer device',
        origin: 'https://desktop.example.com',
        referer: 'https://desktop.example.com/',
        connection: 'keep-alive',
        upgrade: 'websocket',
        'accept-encoding': 'gzip, br',
        forwarded: 'for=10.0.0.1',
        'sec-fetch-site': 'cross-site',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        'sec-websocket-extensions': 'permessage-deflate',
        'sec-websocket-protocol': 'dsh',
        'x-forwarded-host': 'desktop.example.com',
        'x-forwarded-for': '10.0.0.1',
        'x-dsh-rc-remote': '1',
        'x-dsh-something': 'value',
        accept: 'text/html',
        'content-type': 'application/json',
        'user-agent': 'test-agent',
        'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'],
        'x-undefined': undefined,
      },
    }, { upstreamPort: 53421, cookie: 'dsh_rc=host' })

    expect(headers).toEqual({
      accept: 'text/html',
      'content-type': 'application/json',
      'user-agent': 'test-agent',
      'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'],
      host: '127.0.0.1:53421',
      cookie: 'dsh_rc=host',
      [REMOTE_MARK]: '1',
      origin: 'http://127.0.0.1:53421',
      'sec-fetch-site': 'same-origin',
      'accept-encoding': 'identity',
    })
    expect(Object.keys(headers)).not.toContain('x-undefined')
    expect(REMOTE_MARK).toBe('x-dsh-rc-remote')
  })

  it('injects only the envelope when the remote request has no headers', () => {
    expect(upstreamRequestHeaders({ headers: {} }, { upstreamPort: 43128, cookie: 'dsh_rc=abc' })).toEqual({
      host: '127.0.0.1:43128',
      cookie: 'dsh_rc=abc',
      [REMOTE_MARK]: '1',
      origin: 'http://127.0.0.1:43128',
      'sec-fetch-site': 'same-origin',
      'accept-encoding': 'identity',
    })
  })

  it('lets the caller override the remote marker', () => {
    const headers = upstreamRequestHeaders({ headers: { accept: '*/*' } }, { upstreamPort: 1, cookie: 'c', mark: 'x-other-mark' })
    expect(headers).toEqual({
      accept: '*/*',
      host: '127.0.0.1:1',
      cookie: 'c',
      'x-other-mark': '1',
      origin: 'http://127.0.0.1:1',
      'sec-fetch-site': 'same-origin',
      'accept-encoding': 'identity',
    })
    expect(headers).not.toHaveProperty(REMOTE_MARK)
  })
})
