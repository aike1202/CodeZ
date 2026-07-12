const fs = require('node:fs')

const [, , webSocketUrl, outputPath, expressionPath] = process.argv
const socket = new WebSocket(webSocketUrl)
const timeout = setTimeout(() => {
  console.error('Timed out waiting for the screenshot')
  socket.close()
  process.exitCode = 1
}, 5000)

socket.addEventListener('open', () => {
  if (expressionPath) {
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: fs.readFileSync(expressionPath, 'utf8'),
        awaitPromise: true,
        returnByValue: true
      }
    }))
    return
  }

  captureScreenshot()
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id === 1) {
    if (message.result?.exceptionDetails) {
      console.error(message.result.exceptionDetails.text)
      process.exitCode = 1
    }
    setTimeout(captureScreenshot, 250)
    return
  }
  if (message.id !== 2) return

  clearTimeout(timeout)
  fs.writeFileSync(outputPath, Buffer.from(message.result.data, 'base64'))
  console.log(outputPath)
  socket.close()
})

function captureScreenshot() {
  socket.send(JSON.stringify({
    id: 2,
    method: 'Page.captureScreenshot',
    params: { format: 'png', captureBeyondViewport: false }
  }))
}

socket.addEventListener('error', (event) => {
  clearTimeout(timeout)
  console.error(event.message)
  process.exitCode = 1
})
