// Minimal HTTP CONNECT proxy for the feishu-gateway live test: accepts
// CONNECT host:port, opens a raw TCP tunnel, and pipes both ways. Enough for
// axios's HttpsProxyAgent and ws's CONNECT path — no caching, no auth.
import net from 'node:net'

const port = Number(process.argv[2] ?? 13099)
const seen = []
const server = net.createServer(socket => {
  socket.once('data', chunk => {
    const head = chunk.toString('latin1')
    const m = /^CONNECT ([^: ]+):(\d+) HTTP\/1\.1/.exec(head)
    if (m === null) { socket.destroy(); return }
    seen.push(`${m[1]}:${m[2]}`)
    console.log(`[proxy] CONNECT ${m[1]}:${m[2]}`)
    const upstream = net.connect(Number(m[2]), m[1], () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket); socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
})
server.listen(port, '127.0.0.1', () => console.log(`[proxy] listening on 127.0.0.1:${port}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
