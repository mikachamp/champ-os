const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const L = require('../offline-lib')

function run(chunks) {
  const out = { t: [], done: 0, err: [] }
  const p = L.createSSEParser({ onDelta: t => out.t.push(t), onDone: () => out.done++, onError: e => out.err.push(e) })
  chunks.forEach(c => p.feed(c)); p.flush()
  return out
}
const ev = s => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`

test('parses whole events and DONE', () => {
  const o = run([ev('Hel'), ev('lo'), 'data: [DONE]\n\n'])
  assert.deepStrictEqual(o.t, ['Hel', 'lo']); assert.strictEqual(o.done, 1)
})
test('handles events split across chunks at arbitrary points', () => {
  const full = ev('Hi ') + ev('there') + 'data: [DONE]\n\n'
  for (let i = 1; i < full.length; i += 7) {
    const o = run([full.slice(0, i), full.slice(i)])
    assert.strictEqual(o.t.join(''), 'Hi there'); assert.strictEqual(o.done, 1)
  }
})
test('handles CRLF, comments, role-only deltas, bad JSON', () => {
  const o = run([': keepalive\r\n', 'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n', 'data: {oops\n', ev('ok').replace(/\n/g, '\r\n')])
  assert.deepStrictEqual(o.t, ['ok'])
})
test('ignores data after DONE and reports error payloads', () => {
  const o = run(['data: [DONE]\n', ev('late')]); assert.deepStrictEqual(o.t, [])
  const e = run(['data: {"error":{"message":"boom"}}\n']); assert.deepStrictEqual(e.err, ['boom'])
})
test('keeps markup in model text untouched (escaping is the renderer job)', () => {
  assert.deepStrictEqual(run([ev('<img src=x onerror=alert(1)>')]).t, ['<img src=x onerror=alert(1)>'])
})
test('unterminated final line is flushed', () => {
  assert.deepStrictEqual(run(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'z' } }] })]).t, ['z'])
})

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'offl-')), 'sub', 'offline-settings.json')
test('settings: defaults when missing, persists lastModel across loads', () => {
  const f = tmp()
  assert.strictEqual(L.loadSettings(f).lastModel, '')
  L.saveSettings(f, { lastModel: 'qwen/qwen3-4b' })
  assert.strictEqual(L.loadSettings(f).lastModel, 'qwen/qwen3-4b')
  L.saveSettings(f, { llamaServerPath: 'C:\\x\\llama-server.exe' })
  const s = L.loadSettings(f)
  assert.strictEqual(s.lastModel, 'qwen/qwen3-4b'); assert.strictEqual(s.llamaServerPath, 'C:\\x\\llama-server.exe')
})
test('settings: rejects unknown keys, non-local URLs, wrong types; survives corrupt file', () => {
  const f = tmp()
  L.saveSettings(f, { evil: 1, serverUrl: 'http://example.com:1234', lastModel: 5 })
  const s = L.loadSettings(f)
  assert.ok(!('evil' in s)); assert.strictEqual(s.serverUrl, L.DEFAULTS.serverUrl); assert.strictEqual(s.lastModel, '')
  fs.writeFileSync(f, '{not json'); assert.deepStrictEqual(L.loadSettings(f), L.DEFAULTS)
  L.saveSettings(f, { serverUrl: 'http://localhost:8081' }); assert.strictEqual(L.loadSettings(f).serverUrl, 'http://localhost:8081')
})
test('llama config: never guesses, reports what is missing', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-')); const exe = path.join(d, 'llama-server.exe'), gg = path.join(d, 'm.gguf')
  assert.strictEqual(L.checkLlamaConfig({ llamaServerPath: '', llamaModelPath: '' }).reason, 'no-server-path')
  assert.strictEqual(L.checkLlamaConfig({ llamaServerPath: exe, llamaModelPath: gg }).reason, 'server-not-found')
  fs.writeFileSync(exe, ''); assert.strictEqual(L.checkLlamaConfig({ llamaServerPath: exe, llamaModelPath: '' }).reason, 'no-model-path')
  assert.strictEqual(L.checkLlamaConfig({ llamaServerPath: exe, llamaModelPath: gg }).reason, 'model-not-found')
  fs.writeFileSync(gg, ''); assert.ok(L.checkLlamaConfig({ llamaServerPath: exe, llamaModelPath: gg }).ok)
})
test('llama config: only runs llama-server(.exe) with a .gguf model', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-'))
  const evil = path.join(d, 'calc.exe'), exe = path.join(d, 'llama-server.exe'), gg = path.join(d, 'm.gguf'), txt = path.join(d, 'm.txt')
  ;[evil, exe, gg, txt].forEach(f => fs.writeFileSync(f, ''))
  assert.strictEqual(L.checkLlamaConfig({ llamaServerPath: evil, llamaModelPath: gg }).reason, 'server-not-llama')
  assert.strictEqual(L.checkLlamaConfig({ llamaServerPath: exe, llamaModelPath: txt }).reason, 'model-not-gguf')
  assert.ok(L.checkLlamaConfig({ llamaServerPath: path.join(d, 'LLAMA-SERVER'), llamaModelPath: gg }).reason === 'server-not-found')
})
test('portInUse sees a listening port and a free one', async () => {
  const srv = require('net').createServer().listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  const port = srv.address().port
  assert.strictEqual(await L.portInUse(port), true)
  await new Promise(r => srv.close(r))
  assert.strictEqual(await L.portInUse(port), false)
})
test('llama args are fixed and user text stays one argv entry', () => {
  assert.deepStrictEqual(L.buildLlamaArgs('C:\\m & calc.gguf', 'http://127.0.0.1:1234'), ['-m', 'C:\\m & calc.gguf', '--host', '127.0.0.1', '--port', '1234'])
})
test('sanitizeMessages drops bad roles/types and bounds history', () => {
  const m = L.sanitizeMessages([{ role: 'user', content: 'a' }, { role: 'tool', content: 'x' }, { role: 'user', content: 5 }, null])
  assert.deepStrictEqual(m, [{ role: 'user', content: 'a' }])
  assert.strictEqual(L.sanitizeMessages(Array(100).fill({ role: 'user', content: 'a' })).length, 40)
})
