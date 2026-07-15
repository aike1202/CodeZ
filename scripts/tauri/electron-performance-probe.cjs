const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app } = require('electron')

const startedAt = process.hrtime.bigint()
const temporaryUserData = process.env.CODEZ_PERF_USER_DATA ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'codez-electron-baseline-'))
app.setPath('userData', temporaryUserData)

let didFinishLoadMs = null
let readyToShowMs = null
let firstAnimationFrameMs = null
let completed = false

function elapsedMs() {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000
}

function complete(window) {
  if (completed) return
  completed = true
  setTimeout(() => {
    const processMetrics = app.getAppMetrics()
    const totalWorkingSetBytes = processMetrics.reduce(
      (total, metric) => total + metric.memory.workingSetSize * 1024,
      0
    )
    const payload = {
      didFinishLoadMs,
      readyToShowMs,
      firstAnimationFrameMs,
      totalWorkingSetBytes,
      processCount: processMetrics.length,
      rendererResponsive: !window.webContents.isCrashed()
    }
    process.stdout.write(`CODEZ_PERF_BASELINE:${JSON.stringify(payload)}\n`)
    app.quit()
    setTimeout(() => app.exit(0), 5_000).unref()
  }, 2_000)
}

app.on('browser-window-created', (_event, window) => {
  process.stdout.write('CODEZ_PERF_EVENT:window-created\n')
  window.webContents.once('did-finish-load', () => {
    didFinishLoadMs = elapsedMs()
    process.stdout.write('CODEZ_PERF_EVENT:did-finish-load\n')
    window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())))'
    ).then(() => {
      firstAnimationFrameMs = elapsedMs()
      complete(window)
    }).catch(() => complete(window))
  })
  window.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
    process.stderr.write(`Electron renderer failed to load (${errorCode}): ${errorDescription}\n`)
  })
  window.webContents.once('render-process-gone', (_event, details) => {
    process.stderr.write(`Electron renderer exited: ${JSON.stringify(details)}\n`)
  })
  window.once('ready-to-show', () => {
    readyToShowMs = elapsedMs()
    complete(window)
  })
})

setTimeout(() => {
  if (!completed) {
    process.stderr.write('Electron baseline probe timed out before ready-to-show.\n')
    app.exit(2)
  }
}, 30_000).unref()

require(path.join(__dirname, '..', '..', 'out', 'main', 'index.js'))
