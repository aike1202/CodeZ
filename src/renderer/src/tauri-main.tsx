import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

import { ErrorBoundary } from './components/ErrorBoundary'
import { tauriBridge } from './adapters/tauriBridge'

// Inject the Tauri compatibility layer into window.api
;(window as any).api = tauriBridge

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
