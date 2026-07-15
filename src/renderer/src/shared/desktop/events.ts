import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type { DesktopEvent, ThemeInfo } from './generated/contracts'

const THEME_CHANGED_EVENT = 'desktop://theme-changed'

export interface DesktopEvents {
  theme: {
    onChanged(callback: (event: DesktopEvent<ThemeInfo>) => void): Promise<UnlistenFn>
  }
}

export const desktopEvents: DesktopEvents = {
  theme: {
    onChanged: async (callback) => {
      return listen<DesktopEvent<ThemeInfo>>(THEME_CHANGED_EVENT, (event) => callback(event.payload))
    }
  }
}
