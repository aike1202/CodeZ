const fs = require('node:fs')
const { app, safeStorage } = require('electron')

const [outputPath, userDataPath] = process.argv.slice(-2)
if (!outputPath || !userDataPath) {
  console.error('usage: electron safe-storage-probe-electron.cjs <output-file> <isolated-user-data>')
  process.exit(2)
}

function fail(message, code) {
  fs.writeFileSync(`${outputPath}.error`, message, { encoding: 'utf8', mode: 0o600 })
  app.exit(code)
}

try {
  fs.mkdirSync(userDataPath, { recursive: true })
  app.setPath('userData', userDataPath)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1)
}

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    fail('Electron safeStorage encryption is unavailable.', 3)
    return
  }

  const encrypted = safeStorage.encryptString('codez-safe-storage-probe-v1')
  fs.writeFileSync(outputPath, encrypted.toString('base64'), { encoding: 'utf8', mode: 0o600 })
  console.log(JSON.stringify({ available: true, encryptedBytes: encrypted.length }))
  app.quit()
}).catch((error) => {
  fail(error instanceof Error ? error.message : String(error), 1)
})
