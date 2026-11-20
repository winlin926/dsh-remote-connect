/**
 * A stand-in for the public entry during isolated QA.
 *
 * It listens on its own origin, forwards HTTP and WebSocket traffic to the Host's gateway, and
 * rewrites Host/Origin so the gateway admits the request as its own. Killing this process is the
 * test's version of "the public tunnel is gone": the page keeps its origin and its cookies, exactly
 * like a phone that paired through a domain, while the hop that carried them stops existing.
 */
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { target: { type: 'string' }, port: { type: 'string' } } })
const [host, targetPort] = String(values.target ?? '127.0.0.1:18443').split(':')
const authority = host + ':' + targetPort
const port = Number(values.port ?? 19000)
let served = 0

const server = createServer((req, res) => {
  served += 1
  const headers = { ...req.headers, host: authority, origin: 'http://' + authority, referer: 'http://' + authority + '/' }
  delete headers['if-none-match']
  const upstream = httpRequest({ host, port: Number(targetPort), method: req.method, path: req.url, headers }, answer => {
    res.writeHead(answer.statusCode ?? 502, answer.headers)
    answer.pipe(res)
  })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
  res.once('close', () => upstream.destroy())
  req.pipe(upstream)
})

server.on('upgrade', (req, socket, head) => {
  served += 1
  const upstream = connect(Number(targetPort), host, () => {
    const lines = ['GET ' + req.url + ' HTTP/1.1', 'Host: ' + authority, 'Origin: http://' + authority]
    for (const [name, value] of Object.entries(req.headers)) {
      const key = name.toLowerCase()
      if (key === 'host' || key === 'origin' || key === 'connection' || key === 'upgrade') continue
      if (Array.isArray(value)) for (const item of value) lines.push(name + ': ' + item)
      else if (value !== undefined) lines.push(name + ': ' + value)
    }
    lines.push('Connection: Upgrade', 'Upgrade: ' + String(req.headers.upgrade ?? 'websocket'), '', '')
    upstream.write(lines.join('\r\n'))
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream); upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('close', () => socket.destroy())
})

server.listen(port, '127.0.0.1', () => {
  console.log('PUBLIC_ENTRY http://' + host + ':' + port + '/ -> ' + authority)
})
process.on('SIGTERM', () => { server.closeAllConnections?.(); server.close(() => process.exit(0)) })
setInterval(() => { if (served > 0) console.log('proxied=' + served) }, 5000).unref()
