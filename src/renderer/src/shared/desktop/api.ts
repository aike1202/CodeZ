import { Channel, invoke } from '@tauri-apps/api/core'

import type {
  DesktopEvent,
  HealthResponse,
  SystemProbeEvent,
  ThemeInfo,
  ThemeSource,
  WindowAction
} from './generated/contracts'
import { normalizeDesktopError } from './errors'

async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args)
  } catch (error) {
    throw normalizeDesktopError(error)
  }
}

export interface DesktopApi {
  system: {
    health(): Promise<HealthResponse>
    probe(): Promise<Array<DesktopEvent<SystemProbeEvent>>>
  }
  window: {
    control(action: WindowAction): Promise<void>
    openExternal(target: string): Promise<void>
  }
  workspace: {
    openDirectory(): Promise<string | null>
  }
  theme: {
    get(): Promise<ThemeInfo>
    set(source: ThemeSource): Promise<ThemeInfo>
  }
}

export const desktopApi: DesktopApi = {
  system: {
    health: () => command('system_health'),
    probe: () => new Promise((resolve, reject) => {
      const received: Array<DesktopEvent<SystemProbeEvent>> = []
      const events = new Channel<DesktopEvent<SystemProbeEvent>>()
      let commandCompleted = false
      const timeout = window.setTimeout(() => {
        reject(new Error('Desktop channel probe timed out'))
      }, 5_000)
      const finish = (): void => {
        if (!commandCompleted || received.length !== 3) return
        window.clearTimeout(timeout)
        resolve(received)
      }
      events.onmessage = (event) => {
        if (received.length < 3) received.push(event)
        finish()
      }
      void command<void>('system_probe_channel', { events }).then(() => {
        commandCompleted = true
        finish()
      }).catch((error) => {
        window.clearTimeout(timeout)
        reject(error)
      })
    })
  },
  window: {
    control: (action) => command('window_control', { action }),
    openExternal: (target) => command('open_external', { target })
  },
  workspace: {
    openDirectory: () => command('workspace_open_directory')
  },
  theme: {
    get: () => command('theme_get'),
    set: (source) => command('theme_set', { source })
  }
}
