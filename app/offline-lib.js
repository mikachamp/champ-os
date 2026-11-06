// offline-lib.js — pure helpers for the Offline Chat page (no Electron imports, so node --test can load it).
const fs = require('fs')
const path = require('path')
const net = require('net')

// ── SSE parsing (OpenAI-compatible /v1/chat/completions with stream:true) ─────
// Feed raw text chunks in any split; onDelta(text) fires per content token,
// onDone() once on [DONE]. Handles CRLF, split lines, comments and bad JSON.
function createSSEParser({ onDelta, onDone, onError } = {}) {
  let buf = ''
  let done = false
  function handleLine(line) {
    if (done || !line || line.startsWith(':')) return
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data) return
    if (data === '[DONE]') { done = true; onDone && onDone(); return }
    let obj
    try { obj = JSON.parse(data) } catch { return }
    if (obj && obj.error) { onError && onError(String(obj.error.message || obj.error)); return }
    const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta
    const text = delta && typeof delta.content === 'string' ? delta.content : ''
    if (text) onDelta && onDelta(text)
  }
  return {
    feed(chunk) {
      buf += chunk
      let idx
      while ((idx = buf.search(/\r?\n/)) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(buf[idx] === '\r' ? idx + 2 : idx + 1)
        handleLine(line)
      }
    },
    flush() { if (buf) { handleLine(buf.replace(/\r$/, '')); buf = '' } },
    get done() { return done }
  }
}

// ── Settings persistence (userData/offline-settings.json) ─────────────────────
const DEFAULTS = {
  lastModel: '',
  serverUrl: 'http://127.0.0.1:1234',
  llamaServerPath: '',
  llamaModelPath: ''
}

function isLocalUrl(u) {
  try {
    const p = new URL(u)
    return p.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname)
  } catch { return false }
}

const pathOk = v => typeof v === 'string' && v.length <= 500 && !v.includes('\0')
const VALIDATORS = {
  lastModel: v => typeof v === 'string' && v.length <= 300,
  serverUrl: v => typeof v === 'string' && isLocalUrl(v),
  llamaServerPath: pathOk,
  llamaModelPath: pathOk
}

function loadSettings(file) {
  let stored = {}
  try { stored = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch {}
  const out = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) {
    if (stored && k in stored && VALIDATORS[k](stored[k])) out[k] = stored[k]
  }
  return out
}

// Only whitelisted, valid keys are written. Returns the merged settings.
function saveSettings(file, patch) {
  const next = loadSettings(file)
  for (const k of Object.keys(patch || {})) {
    if (k in DEFAULTS && VALIDATORS[k](patch[k])) next[k] = patch[k].trim()
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, file)
  return next
}

// ── llama-server launch ───────────────────────────────────────────────────────
function portOf(serverUrl) {
  return Number(new URL(serverUrl).port) || 80
}

// Fixed args only; user values are passed as separate argv entries (no shell).
function buildLlamaArgs(modelPath, serverUrl) {
  return ['-m', modelPath, '--host', '127.0.0.1', '--port', String(portOf(serverUrl))]
}

function isFile(p) { try { return !!p && fs.statSync(p).isFile() } catch { return false } }

// Returns { ok, reason } — never guesses a path.
function checkLlamaConfig(s) {
  if (!s.llamaServerPath) return { ok: false, reason: 'no-server-path' }
  // A tampered settings file must not be able to launch some other program.
  if (!/^llama-server(\.exe)?$/i.test(path.basename(s.llamaServerPath))) return { ok: false, reason: 'server-not-llama' }
  if (!isFile(s.llamaServerPath)) return { ok: false, reason: 'server-not-found' }
  if (!s.llamaModelPath) return { ok: false, reason: 'no-model-path' }
  if (!/\.gguf$/i.test(s.llamaModelPath)) return { ok: false, reason: 'model-not-gguf' }
  if (!isFile(s.llamaModelPath)) return { ok: false, reason: 'model-not-found' }
  return { ok: true }
}

// True when something already listens on 127.0.0.1:port (e.g. LM Studio on 1234),
// so Start refuses instead of silently talking to the other server.
function portInUse(port, timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = v => { sock.destroy(); resolve(v) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

// Keep only well-formed chat messages (role + string content), bounded.
function sanitizeMessages(msgs) {
  if (!Array.isArray(msgs)) return []
  return msgs.slice(-40)
    .filter(m => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }))
}

module.exports = { createSSEParser, DEFAULTS, loadSettings, saveSettings, isLocalUrl, portOf, buildLlamaArgs, checkLlamaConfig, portInUse, sanitizeMessages }
