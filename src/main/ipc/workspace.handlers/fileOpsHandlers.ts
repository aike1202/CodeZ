import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../../shared/ipc/channels'
import { WorkspaceService } from '../../services/WorkspaceService'

let currentWorkspaceService: WorkspaceService | null = null

export function getWorkspaceService(): WorkspaceService | null {
  return currentWorkspaceService
}

const editorDefinitions = [
  { id: 'VSCode', name: 'VSCode', cmd: 'code', winDirs: ['Microsoft VS Code'], exe: 'Code.exe' },
  { id: 'Cursor', name: 'Cursor', cmd: 'cursor', winDirs: ['cursor'], exe: 'Cursor.exe' },
  {
    id: 'IntelliJ IDEA',
    name: 'IntelliJ IDEA',
    cmd: 'idea',
    winDirs: ['JetBrains/IntelliJ IDEA'],
    exe: 'bin/idea64.exe',
    backupCmd: 'idea64'
  },
  {
    id: 'PyCharm',
    name: 'PyCharm',
    cmd: 'pycharm',
    winDirs: ['JetBrains/PyCharm'],
    exe: 'bin/pycharm64.exe',
    backupCmd: 'pycharm64'
  },
  {
    id: 'WebStorm',
    name: 'WebStorm',
    cmd: 'webstorm',
    winDirs: ['JetBrains/WebStorm'],
    exe: 'bin/webstorm64.exe',
    backupCmd: 'webstorm64'
  },
  {
    id: 'CLion',
    name: 'CLion',
    cmd: 'CLion',
    winDirs: ['JetBrains/CLion'],
    exe: 'bin/clion64.exe',
    backupCmd: 'clion64'
  },
  { id: 'Sublime Text', name: 'Sublime Text', cmd: 'subl', winDirs: ['Sublime Text'], exe: 'sublime_text.exe' },
  {
    id: 'Android Studio',
    name: 'Android Studio',
    cmd: 'studio',
    winDirs: ['Android/Android Studio', 'Android Studio'],
    exe: 'bin/studio64.exe',
    backupCmd: 'studio64'
  },
  { id: 'HBuilderX', name: 'HBuilderX', cmd: 'hbuilderx', winDirs: ['HBuilderX'], exe: 'HBuilderX.exe' },
  { id: 'Eclipse', name: 'Eclipse', cmd: 'eclipse', winDirs: ['eclipse'], exe: 'eclipse.exe' }
]

function findIconBfs(rootDir: string, targetNames: string[], maxDepth: number = 8): string | null {
  const queue: { currentPath: string; depth: number }[] = [{ currentPath: rootDir, depth: 0 }]
  const visited = new Set<string>()

  while (queue.length > 0) {
    const { currentPath, depth } = queue.shift()!
    if (depth > maxDepth) continue
    if (visited.has(currentPath)) continue
    visited.add(currentPath)

    try {
      const stats = fs.statSync(currentPath)
      if (!stats.isDirectory()) continue

      const entries = fs.readdirSync(currentPath, { withFileTypes: true })
      const filesInDir = entries.filter((e) => e.isFile()).map((e) => e.name)
      for (const targetName of targetNames) {
        const match = filesInDir.find((name) => name.toLowerCase() === targetName)
        if (match) {
          return path.join(currentPath, match)
        }
      }

      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'node_modules' && depth < maxDepth) {
          queue.push({ currentPath: path.join(currentPath, entry.name), depth: depth + 1 })
        }
      }
    } catch {}
  }
  return null
}

function getLocalEditorIcon(exePath: string, id: string): string | null {
  try {
    const cacheDir = path.join(app.getPath('userData'), 'ide-icons')
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    const cachedIco = path.join(cacheDir, `${id}.ico`)
    const cachedPng = path.join(cacheDir, `${id}.png`)
    const cachedSvg = path.join(cacheDir, `${id}.svg`)

    let cachedFile = [cachedPng, cachedSvg, cachedIco].find((f) => fs.existsSync(f))

    if (cachedFile === cachedIco && (id === 'VSCode' || id === 'Cursor')) {
      try {
        fs.unlinkSync(cachedIco)
      } catch (e) {}
      cachedFile = undefined
    }

    if (cachedFile) {
      const fileData = fs.readFileSync(cachedFile)
      const ext = path.extname(cachedFile).toLowerCase()
      if (ext === '.svg') return `data:image/svg+xml;base64,${fileData.toString('base64')}`
      if (ext === '.png') return `data:image/png;base64,${fileData.toString('base64')}`
      if (ext === '.ico') return `data:image/x-icon;base64,${fileData.toString('base64')}`
    }

    const binDir = path.dirname(exePath)
    const parentDir = path.dirname(binDir)
    const searchRoot = binDir.toLowerCase().endsWith('bin') ? parentDir : binDir

    let baseName = ''
    if (id === 'IntelliJ IDEA') baseName = 'idea'
    else if (id === 'PyCharm') baseName = 'pycharm'
    else if (id === 'WebStorm') baseName = 'webstorm'
    else if (id === 'CLion') baseName = 'clion'
    else if (id === 'Android Studio') baseName = 'studio'
    else if (id === 'Sublime Text') baseName = 'sublime_text'
    else if (id === 'HBuilderX') baseName = 'HBuilderX'
    else if (id === 'Eclipse') baseName = 'eclipse'
    else if (id === 'VSCode') baseName = 'code'
    else if (id === 'Cursor') baseName = 'code'

    if (!baseName) return null

    const targetNames = [
      `${baseName}_150x150.png`,
      `${baseName}_70x70.png`,
      `${baseName}.png`,
      `${baseName}.svg`,
      `${baseName}.ico`,
      'app.ico',
      'icon.ico'
    ].map((n) => n.toLowerCase())

    const fastPaths = [
      path.join(searchRoot, 'resources', 'win32'),
      path.join(searchRoot, 'resources', 'app', 'resources', 'win32'),
      path.join(binDir, '..', '..'),
      path.join(binDir, '..'),
      path.dirname(exePath)
    ]

    let foundFile: string | null = null
    for (const fp of fastPaths) {
      if (!fs.existsSync(fp)) continue
      try {
        const entries = fs.readdirSync(fp, { withFileTypes: true })
        const filesInDir = entries.filter((e) => e.isFile()).map((e) => e.name)
        for (const targetName of targetNames) {
          const match = filesInDir.find((name) => name.toLowerCase() === targetName)
          if (match) {
            foundFile = path.join(fp, match)
            break
          }
        }
      } catch {}
      if (foundFile) break
    }

    if (!foundFile) {
      foundFile = findIconBfs(searchRoot, targetNames, 8)
    }

    if (!foundFile) return null

    const ext = path.extname(foundFile).toLowerCase()
    const cachePath = path.join(cacheDir, `${id}${ext}`)
    try {
      fs.copyFileSync(foundFile, cachePath)
    } catch (e) {
      console.warn('缓存图标写入失败', e)
    }

    const fileData = fs.readFileSync(foundFile)
    if (ext === '.svg') return `data:image/svg+xml;base64,${fileData.toString('base64')}`
    if (ext === '.png') return `data:image/png;base64,${fileData.toString('base64')}`
    if (ext === '.ico') return `data:image/x-icon;base64,${fileData.toString('base64')}`

    return null
  } catch (error) {
    console.error(`提取本地图标失败: ${exePath}`, error)
    return null
  }
}

export function registerFileOpsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.OPEN_DIRECTORY, async (): Promise<string | null> => {
    const window = BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory'],
      title: '选择项目目录'
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })

  ipcMain.handle(IPC_CHANNELS.SCAN_FILE_TREE, async (_event, rootPath: string) => {
    try {
      currentWorkspaceService = new WorkspaceService(rootPath)
      return await currentWorkspaceService.scanFileTree()
    } catch (error) {
      console.error('SCAN_FILE_TREE error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.GET_ALL_PATHS, async (_event, rootPath: string) => {
    try {
      const service =
        currentWorkspaceService?.getCurrentWorkspace() === rootPath
          ? currentWorkspaceService
          : new WorkspaceService(rootPath)
      return await service.getAllPaths()
    } catch (error) {
      console.error('GET_ALL_PATHS error:', error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.READ_FILE, async (_event, filePath: string, rootPath?: string) => {
    if (!rootPath) {
      return { path: filePath, content: '[错误: 缺少 Workspace 路径]', truncated: false, totalLines: 0 }
    }
    try {
      const service = new WorkspaceService(rootPath)
      return await service.readFileContent(filePath)
    } catch (error) {
      return {
        path: filePath,
        content: `[读取文件失败] ${error instanceof Error ? error.message : String(error)}`,
        truncated: false,
        totalLines: 0
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.OPEN_IN_EXPLORER, async (_event, rootPath: string): Promise<boolean> => {
    try {
      await shell.openPath(rootPath)
      return true
    } catch (error) {
      console.error('Failed to open path in explorer:', error)
      return false
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.OPEN_IN_EDITOR,
    async (_event, rootPath: string, editorId: string, exePath: string | null): Promise<boolean> => {
      return new Promise((resolve) => {
        let command = ''

        if (exePath) {
          command = `"${exePath}" "${rootPath}"`
        } else {
          const def = editorDefinitions.find((d) => d.id === editorId)
          const cmd = def ? def.cmd : 'code'
          command = `${cmd} "${rootPath}"`
        }

        exec(command, (error) => {
          if (error) {
            console.error(`打开编辑器失败: ${command}`, error)
            if (editorId === 'IntelliJ IDEA' && !exePath) {
              exec(`idea64 "${rootPath}"`, (error2) => {
                resolve(!error2)
              })
              return
            }
            resolve(false)
          } else {
            resolve(true)
          }
        })
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.DETECT_INSTALLED_EDITORS,
    async (): Promise<Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }>> => {
      const getCommandPath = (cmd: string): Promise<string | null> => {
        return new Promise((resolve) => {
          const whereCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`
          exec(whereCmd, (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve(null)
            } else {
              resolve(stdout.split('\n')[0].trim())
            }
          })
        })
      }

      const userProfile = process.env.USERPROFILE || ''
      const localAppData =
        process.env.LOCALAPPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '')
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
      const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'

      const searchBases = [
        localAppData ? path.join(localAppData, 'Programs') : '',
        programFiles,
        programFilesX86,
        userProfile
      ].filter(Boolean)

      const installed: Array<{
        id: string
        name: string
        exePath: string | null
        iconPath: string | null
      }> = []

      for (const def of editorDefinitions) {
        let actualPath = await getCommandPath(def.cmd)
        if (!actualPath && def.backupCmd) {
          actualPath = await getCommandPath(def.backupCmd)
        }

        if (actualPath) {
          installed.push({
            id: def.id,
            name: def.name,
            exePath: actualPath,
            iconPath: getLocalEditorIcon(actualPath, def.id)
          })
          continue
        }

        let foundPath: string | null = null
        for (const base of searchBases) {
          for (const dirName of def.winDirs) {
            if (dirName.startsWith('JetBrains/')) {
              const jbParent = path.join(base, 'JetBrains')
              if (fs.existsSync(jbParent)) {
                try {
                  const subdirs = fs.readdirSync(jbParent)
                  const targetSub = subdirs.find((s) =>
                    s.toLowerCase().includes(dirName.split('/')[1].toLowerCase())
                  )
                  if (targetSub) {
                    const checkExe = path.join(jbParent, targetSub, def.exe)
                    if (fs.existsSync(checkExe)) {
                      foundPath = checkExe
                      break
                    }
                  }
                } catch {}
              }
            } else {
              const checkExe = path.join(base, dirName, def.exe)
              if (fs.existsSync(checkExe)) {
                foundPath = checkExe
                break
              }
            }
          }
          if (foundPath) break
        }

        if (foundPath) {
          installed.push({
            id: def.id,
            name: def.name,
            exePath: foundPath,
            iconPath: getLocalEditorIcon(foundPath, def.id)
          })
        }
      }

      if (installed.length === 0) {
        installed.push({ id: 'VSCode', name: 'VSCode', exePath: null, iconPath: null })
      }

      return installed
    }
  )
}
