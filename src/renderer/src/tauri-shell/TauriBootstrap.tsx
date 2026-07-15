import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, Maximize2, Minus, RefreshCw, X } from 'lucide-react'

import { desktopApi, desktopEvents, type HealthResponse, type ThemeInfo } from '../shared/desktop'

type HostState =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse; channelSteps: number }
  | { kind: 'error'; message: string }

export default function TauriBootstrap(): React.ReactElement {
  const [host, setHost] = useState<HostState>({ kind: 'loading' })
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const refreshHealth = useCallback(async () => {
    setHost({ kind: 'loading' })
    try {
      const health = await desktopApi.system.health()
      const channelEvents = await desktopApi.system.probe()
      setHost({ kind: 'ready', health, channelSteps: channelEvents.length })
    } catch (error) {
      setHost({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => {
    void refreshHealth()
  }, [refreshHealth])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const applyTheme = (theme: ThemeInfo): void => {
      document.documentElement.dataset.theme = theme.shouldUseDarkColors ? 'dark' : 'light'
    }

    void desktopApi.theme.get().then(applyTheme).catch(() => undefined)
    void desktopEvents.theme.onChanged((event) => applyTheme(event.payload)).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    }).catch(() => undefined)

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const openDirectory = async (): Promise<void> => {
    const path = await desktopApi.workspace.openDirectory()
    if (path) setSelectedPath(path)
  }

  const ready = host.kind === 'ready'

  return (
    <div className="tauri-bootstrap">
      <header className="tauri-bootstrap__bar" data-tauri-drag-region>
        <div className="tauri-bootstrap__brand" data-tauri-drag-region>
          <span className="tauri-bootstrap__mark">CZ</span>
          <span>CodeZ</span>
          <span className="tauri-bootstrap__phase">Tauri foundation</span>
        </div>
        <div className="tauri-bootstrap__window-actions">
          <button type="button" title="Minimize" aria-label="Minimize" onClick={() => void desktopApi.window.control('minimize')}>
            <Minus size={15} />
          </button>
          <button type="button" title="Maximize" aria-label="Maximize" onClick={() => void desktopApi.window.control('toggleMaximize')}>
            <Maximize2 size={14} />
          </button>
          <button className="tauri-bootstrap__close" type="button" title="Close" aria-label="Close" onClick={() => void desktopApi.window.control('close')}>
            <X size={16} />
          </button>
        </div>
      </header>

      <main className="tauri-bootstrap__workspace">
        <section className="tauri-bootstrap__summary">
          <div className={`tauri-bootstrap__signal tauri-bootstrap__signal--${host.kind}`} aria-hidden="true" />
          <p className="tauri-bootstrap__eyebrow">Desktop runtime</p>
          <h1>{ready ? 'Rust host connected' : host.kind === 'error' ? 'Host unavailable' : 'Connecting to host'}</h1>
          <p className="tauri-bootstrap__message">
            {host.kind === 'error'
              ? host.message
              : 'The typed desktop boundary is responding.'}
          </p>
          <div className="tauri-bootstrap__summary-actions">
            <button type="button" title="Refresh host status" aria-label="Refresh host status" onClick={() => void refreshHealth()}>
              <RefreshCw size={16} className={host.kind === 'loading' ? 'tauri-bootstrap__spin' : undefined} />
            </button>
            <button type="button" title="Choose a workspace" aria-label="Choose a workspace" onClick={() => void openDirectory()}>
              <FolderOpen size={17} />
            </button>
          </div>
        </section>

        <section className="tauri-bootstrap__trace" aria-label="Migration foundation status">
          <div className="tauri-bootstrap__trace-row is-complete">
            <span className="tauri-bootstrap__trace-node" />
            <span className="tauri-bootstrap__trace-label">Tauri window</span>
            <span className="tauri-bootstrap__trace-value">online</span>
          </div>
          <div className={`tauri-bootstrap__trace-row ${ready ? 'is-complete' : ''}`}>
            <span className="tauri-bootstrap__trace-node" />
            <span className="tauri-bootstrap__trace-label">Contract boundary</span>
            <span className="tauri-bootstrap__trace-value">
              {ready ? `v${host.health.contractVersion}` : 'checking'}
            </span>
          </div>
          <div className={`tauri-bootstrap__trace-row ${ready ? 'is-complete' : ''}`}>
            <span className="tauri-bootstrap__trace-node" />
            <span className="tauri-bootstrap__trace-label">Channel boundary</span>
            <span className="tauri-bootstrap__trace-value">
              {ready ? `${host.channelSteps}/3` : 'checking'}
            </span>
          </div>
          <div className="tauri-bootstrap__trace-row is-current">
            <span className="tauri-bootstrap__trace-node" />
            <span className="tauri-bootstrap__trace-label">Domain migration</span>
            <span className="tauri-bootstrap__trace-value">queued</span>
          </div>
          <div className="tauri-bootstrap__trace-row">
            <span className="tauri-bootstrap__trace-node" />
            <span className="tauri-bootstrap__trace-label">Electron removal</span>
            <span className="tauri-bootstrap__trace-value">gated</span>
          </div>
        </section>

        <footer className="tauri-bootstrap__details">
          <span>Backend {ready ? host.health.backendVersion : '--'}</span>
          <span>Uptime {ready ? `${host.health.uptimeMs} ms` : '--'}</span>
          <span className="tauri-bootstrap__path" title={selectedPath ?? undefined}>
            {selectedPath ?? 'No workspace selected'}
          </span>
        </footer>
      </main>
    </div>
  )
}
