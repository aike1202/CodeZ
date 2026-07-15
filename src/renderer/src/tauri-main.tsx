import React from 'react'
import ReactDOM from 'react-dom/client'

import TauriBootstrap from './tauri-shell/TauriBootstrap'
import './tauri-shell/tauri-bootstrap.css'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <TauriBootstrap />
  </React.StrictMode>
)
