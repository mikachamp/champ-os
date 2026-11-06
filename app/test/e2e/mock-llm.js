// Mock OpenAI-compatible streaming server (stands in for LM Studio). Test use only.
const http = require('http')

function createMock(port) {
  const state = { requests: [], closedEarly: 0, completed: 0 }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json')
      return res.end(JSON.stringify({ data: [{ id: 'mock/alpha-7b' }, { id: 'mock/beta-3b' }] }))
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        state.requests.push(parsed)
        const last = parsed.messages[parsed.messages.length - 1].content
        const words = last.includes('LONG')
          ? Array.from({ length: 300 }, (_, i) => `word${i} `)
          : ['Hello ', 'from ', 'the ', 'mock ', 'model. ', '<img src=x onerror="window.__pwn=1"> ', '&amp; ', '<b>not bold</b> ', 'done.']
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        let i = 0, closed = false
        res.on('close', () => { if (i < words.length) { closed = true; state.closedEarly++ } })
        const tick = () => {
          if (closed) return
          if (i >= words.length) { res.write('data: [DONE]\n\n'); state.completed++; return res.end() }
          const chunk = JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })
          // split some events across writes to exercise the parser
          if (i % 3 === 0) { res.write('data: ' + chunk.slice(0, 10)); setTimeout(() => { if (!closed) res.write(chunk.slice(10) + '\n\n') }, 5) }
          else res.write(`data: ${chunk}\n\n`)
          setTimeout(tick, 250)
        }
        tick()
      })
      return
    }
    res.statusCode = 404; res.end()
  })
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, state })))
}
module.exports = { createMock }
