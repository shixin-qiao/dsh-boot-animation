/**
 * verify-boot-animation.mjs - prove the boot overlay fires when DSH starts.
 *
 * Opens the real GUI in headless Edge — the navigation itself is the trigger,
 * since the splash is a startup animation — then reads the overlay and the video
 * element back out of the DOM. If the video reports a real duration and a
 * moving currentTime, the asset was served, decoded and is genuinely playing.
 *
 * Usage: node scripts/verify-boot-animation.mjs <debugPort> <guiUrl>
 */

const port = Number(process.argv[2] ?? 9345)
const url = process.argv[3]
if (url === undefined) {
  console.error('usage: node scripts/verify-boot-animation.mjs <debugPort> <guiUrl>')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* starting */
    }
    await sleep(500)
  }
  throw new Error('no debuggable page target')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    const exceptions = []
    const consoleErrors = []
    const pluginLogs = []
    let nextId = 0
    socket.onopen = () =>
      resolve({
        exceptions,
        consoleErrors,
        pluginLogs,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = (nextId += 1)
            pending.set(id, { res, rej })
            socket.send(JSON.stringify({ id, method, params }))
          })
        },
        close: () => socket.close(),
      })
    socket.onerror = (e) => reject(new Error('ws error ' + String(e?.message ?? e)))
    socket.onmessage = (event) => {
      let m
      try {
        m = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (m.id !== undefined && pending.has(m.id)) {
        const entry = pending.get(m.id)
        pending.delete(m.id)
        if (m.error !== undefined) entry.rej(new Error(JSON.stringify(m.error)))
        else entry.res(m.result)
        return
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails ?? {}
        exceptions.push(String(d.exception?.description ?? d.text ?? 'unknown'))
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args ?? []).map((a) => String(a.value ?? a.description ?? a.type)).join(' ')
        const entry = '[' + m.params.type + '] ' + text
        if (m.params.type === 'error') consoleErrors.push(entry)
        if (text.indexOf('dsh-boot-animation') !== -1) pluginLogs.push(entry)
      }
    }
  })
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.exceptionDetails !== undefined) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
  return r?.result?.value
}

async function waitTrue(client, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await evaluate(client, expression)) return true
    } catch {
      /* navigating */
    }
    await sleep(600)
  }
  return false
}

const page = await waitForPage()
const client = await connect(page.webSocketDebuggerUrl)
await client.send('Runtime.enable')
await client.send('Page.enable')
await client.send('Page.navigate', { url })

const booted = await waitTrue(client, `document.querySelector('.dvi-mic') !== null || document.querySelector('[class*="sidebar"]') !== null`, 75000)
console.log('booted          :', booted)
await sleep(2500)

// The splash is a STARTUP animation: the Page.navigate above is itself the
// trigger, so there is no "new conversation" click to make any more.
const appeared = await waitTrue(client, `document.querySelector('.dba-root') !== null`, 25000)
console.log('overlay appeared:', appeared)

await sleep(3500)

const probe = await evaluate(
  client,
  `(() => {
     const root = document.querySelector('.dba-root');
     const v = document.querySelector('.dba-video');
     if (!root) return JSON.stringify({ overlay: false });
     return JSON.stringify({
       overlay: true,
       hint: (document.querySelector('.dba-hint') || {}).textContent || null,
       skip: (document.querySelector('.dba-skip') || {}).textContent || null,
       videoSrc: v ? v.getAttribute('src') : null,
       readyState: v ? v.readyState : null,
       duration: v ? Number(v.duration?.toFixed?.(2) ?? v.duration) : null,
       videoWidth: v ? v.videoWidth : null,
       videoHeight: v ? v.videoHeight : null,
       paused: v ? v.paused : null,
       muted: v ? v.muted : null,
       currentTime: v ? Number(v.currentTime?.toFixed?.(2) ?? v.currentTime) : null,
       error: v && v.error ? { code: v.error.code, message: v.error.message } : null,
       zIndex: root ? getComputedStyle(root).zIndex : null,
       position: root ? getComputedStyle(root).position : null,
     });
   })()`,
)
console.log('video probe     :', probe)

await sleep(2500)
const advanced = await evaluate(
  client,
  `(() => { const v = document.querySelector('.dba-video'); return JSON.stringify({ currentTime: v ? Number(v.currentTime?.toFixed?.(2) ?? v.currentTime) : null, paused: v ? v.paused : null }); })()`,
)
console.log('after 2.5s      :', advanced)

const skipTest = await evaluate(
  client,
  `(() => {
     const b = document.querySelector('.dba-skip');
     if (!b) return JSON.stringify({ ok: false });
     b.click();
     return JSON.stringify({ ok: true });
   })()`,
)
await sleep(600)
const afterSkip = await evaluate(client, `JSON.stringify({ overlay: document.querySelectorAll('.dba-root').length })`)
console.log('skip clicked    :', skipTest, afterSkip)

console.log('\n--- plugin console output ---')
if (client.pluginLogs.length === 0) console.log('(none)')
for (const line of client.pluginLogs) console.log('  ' + line)

console.log('\nuncaught exceptions:', client.exceptions.length === 0 ? '(none)' : client.exceptions.slice(0, 5))
console.log('console errors     :', client.consoleErrors.length === 0 ? '(none)' : client.consoleErrors.slice(0, 5))
client.close()
process.exit(0)
