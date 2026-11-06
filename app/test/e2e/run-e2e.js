// End-to-end check of the Offline Chat page: real Electron app + puppeteer-core over the debug port,
// against a MOCK streaming server. Usage (from app/):
//   NODE_PATH=<dir with puppeteer-core> node test/e2e/run-e2e.js <screenshotDir>
// Needs ELECTRON_RUN_AS_NODE unset (this script strips it for the child).
const { spawn, execFileSync } = require('child_process')
const fs = require('fs'), os = require('os'), path = require('path')
const puppeteer = require('puppeteer-core')
const { createMock } = require('./mock-llm')

const APP = path.resolve(__dirname, '..', '..')
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'offline-shots'))
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe')
const MOCK_PORT = 18234, FAKE_PORT = 18235, DEBUG_PORT = 9333
fs.mkdirSync(SHOTS, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 't55-'))
const userData = path.join(work, 'userData'), vault = path.join(work, 'fictional-vault')
fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(vault, { recursive: true })
fs.writeFileSync(path.join(vault, 'Welcome.md'), '# Fictional vault\n\nNot Mika\'s real notes.\n')
const settingsFile = path.join(userData, 'offline-settings.json')
const setSettings = o => fs.writeFileSync(settingsFile, JSON.stringify(o))

let pass = 0, fail = 0
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let child = null, browser = null
async function launch() {
  const env = { ...process.env, MIKAOS_NO_AGENTS: '1', MIKAOS_VAULT: vault }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(ELECTRON, [APP, `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${userData}`], { env, stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null }); break } catch { await sleep(500) }
  }
  if (!browser) throw new Error('could not connect to Electron')
  let page
  for (let i = 0; i < 40 && !page; i++) {
    page = (await browser.pages()).find(p => p.url().includes('index.html'))
    if (!page) await sleep(250)
  }
  const errors = []
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  page.errors = errors
  await sleep(1500)
  return page
}
async function quit() {
  try { await browser.disconnect() } catch {}
  browser = null
  if (child) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} child = null }
  await sleep(1500)
}
async function openOffline(page) {
  await page.evaluate(() => document.getElementById('nav-offline-chat').click())
  await sleep(600)
}
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)
async function shot(page, name) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h })
    await sleep(300)
    check(`no horizontal scroll @${w}: ${name}`, await noHScroll(page))
    await page.screenshot({ path: path.join(SHOTS, `${name}-${w}.png`) })
  }
  await page.setViewport({ width: 1440, height: 900 })
}
const bubbleTexts = page => page.evaluate(() => [...document.querySelectorAll('#offlineChatMessages .message-bubble')].map(b => b.textContent))
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150) } return false }

;(async () => {
  const { server, state } = await createMock(MOCK_PORT)
  let allErrors = []
  try {
    // ── Run 1: connected, pick model, stream, markup safety, stop ──
    setSettings({ serverUrl: `http://127.0.0.1:${MOCK_PORT}` })
    let page = await launch()
    await openOffline(page)
    check('pill shows connected', await waitFor(() => page.evaluate(() => /CONNECTED/.test(document.getElementById('offlineStatusPill').textContent))))
    check('not-running panel hidden when up', await page.evaluate(() => document.getElementById('offlineDown').hidden))
    const opts = await page.evaluate(() => [...document.querySelectorAll('#offlineModelSelect option')].map(o => o.value))
    check('model list from server', opts.join() === 'mock/alpha-7b,mock/beta-3b', opts.join())
    await page.select('#offlineModelSelect', 'mock/beta-3b')
    await sleep(500)
    check('choice written to userData settings file', JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lastModel === 'mock/beta-3b')

    await page.type('#offlineChatInput', 'Say hello')
    await page.click('#offlineChatSend')
    check('first token arrives before the reply is complete', await waitFor(async () => {
      const t = await bubbleTexts(page); const last = t[t.length - 1] || ''
      return last.length > 0 && !last.includes('done.')
    }))
    check('stop button visible while streaming', await page.evaluate(() => !document.getElementById('offlineStopBtn').hidden))
    await sleep(500)
    await shot(page, 'streaming')
    check('reply completes', await waitFor(async () => (await bubbleTexts(page)).some(t => t.endsWith('done.')), 20000))
    await waitFor(() => page.evaluate(() => document.getElementById('offlineStopBtn').hidden))
    const texts = await bubbleTexts(page)
    const reply = texts[texts.length - 1]
    check('model markup shown literally (escaped)', reply.includes('<img src=x onerror="window.__pwn=1">') && reply.includes('<b>not bold</b>'))
    check('no element injected from model text', await page.evaluate(() => !document.querySelector('#offlineChatMessages img, #offlineChatMessages b') && !window.__pwn))
    check('request was stream:true with chosen model', state.requests[0]?.stream === true && state.requests[0]?.model === 'mock/beta-3b')
    check('stop button hidden after completion', await page.evaluate(() => document.getElementById('offlineStopBtn').hidden))

    await page.type('#offlineChatInput', 'Write LONG text')
    await page.click('#offlineChatSend')
    await waitFor(async () => { const t = await bubbleTexts(page); return (t[t.length - 1] || '').includes('word2') })
    check('history is sent with the second request', state.requests[1]?.messages.length === 3)
    const before = (await bubbleTexts(page)).pop().length
    await page.click('#offlineStopBtn')
    await sleep(1500)
    const after = (await bubbleTexts(page))
    check('stop ends the stream and says so', after.includes('Stopped.') && await page.evaluate(() => !document.getElementById('offlineChatInput').disabled))
    check('server saw the connection abort', state.closedEarly === 1, `closedEarly=${state.closedEarly}`)
    await sleep(1500)
    const grown = (await bubbleTexts(page)).filter(t => t.startsWith('word0')).pop().length
    check('no more text after stop', grown - before < 40, `before=${before} after=${grown}`)
    allErrors.push(...page.errors)
    await quit()

    // ── Run 2: restart, remembered model ──
    page = await launch()
    await openOffline(page)
    await waitFor(() => page.evaluate(() => /CONNECTED/.test(document.getElementById('offlineStatusPill').textContent)))
    check('model remembered after restart', await page.evaluate(() => document.getElementById('offlineModelSelect').value) === 'mock/beta-3b')
    await shot(page, 'remembered-model')
    allErrors.push(...page.errors)
    await quit()

    // ── Run 3: server down -> not-running state, Start with no path, then Start with fake llama-server ──
    await new Promise(r => server.close(r))
    const fakeDir = path.join(work, 'fake'); fs.mkdirSync(fakeDir)
    const exe = path.join(fakeDir, 'llama-server.exe'), gguf = path.join(fakeDir, 'tiny.gguf')
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', `/out:${exe}`, path.join(__dirname, 'fake-llama.cs')])
    fs.writeFileSync(gguf, 'not a real model')
    setSettings({ serverUrl: `http://127.0.0.1:${FAKE_PORT}`, lastModel: 'mock/beta-3b' })
    page = await launch()
    await openOffline(page)
    check('not-running panel shown', await waitFor(() => page.evaluate(() => !document.getElementById('offlineDown').hidden)))
    const title = await page.evaluate(() => document.querySelector('.offline-down-title').textContent)
    check('panel says "Local model not running"', /Local model not running/.test(title))
    check('pill says not running', await page.evaluate(() => /NOT RUNNING/.test(document.getElementById('offlineStatusPill').textContent)))
    await page.click('#offlineStartBtn')
    await sleep(800)
    const hint = await page.evaluate(() => document.getElementById('offlineSetupHint').textContent)
    check('no path set: tells Mika where to set it, does not guess', /not set/.test(hint) && /Local server settings/.test(hint), hint)
    await shot(page, 'not-running')
    // bad path
    await page.$eval('#offlineExeInput', el => (el.value = ''))
    await page.type('#offlineExeInput', path.join(fakeDir, 'missing', 'llama-server.exe'))
    await page.type('#offlineGgufInput', gguf)
    await page.click('#offlineSaveSettings'); await sleep(600)
    await page.click('#offlineStartBtn'); await sleep(800)
    check('wrong path reported as not found', /No file exists/.test(await page.evaluate(() => document.getElementById('offlineSetupHint').textContent)))
    // good path
    await page.$eval('#offlineExeInput', el => (el.value = ''))
    await page.type('#offlineExeInput', exe)
    await page.click('#offlineSaveSettings'); await sleep(600)
    await page.click('#offlineStartBtn')
    check('progress text shown while starting', await waitFor(() => page.evaluate(() => /Loading the model|Launching/.test(document.getElementById('offlineProgress').textContent)), 5000))
    await sleep(1200)
    await shot(page, 'starting-progress')
    check('connects after retrying; panel hides', await waitFor(() => page.evaluate(() => document.getElementById('offlineDown').hidden && /CONNECTED/.test(document.getElementById('offlineStatusPill').textContent)), 30000))
    const argv = fs.readFileSync(path.join(fakeDir, 'argv.txt'), 'utf8').split('\n')
    check('spawned with fixed args, no shell', argv.join('|') === `-m|${gguf}|--host|127.0.0.1|--port|${FAKE_PORT}`, argv.join('|'))
    allErrors.push(...page.errors)
    await quit()

    const filtered = allErrors
    check('0 console errors', filtered.length === 0, filtered.slice(0, 5).join(' || '))
  } catch (e) {
    fail++; console.log('FAIL  harness error: ' + e.stack)
  } finally {
    await quit().catch(() => {})
    try { server.close() } catch {}
    console.log(`\nE2E: ${pass} passed, ${fail} failed. Screenshots: ${SHOTS}`)
    process.exit(fail ? 1 : 0)
  }
})()
