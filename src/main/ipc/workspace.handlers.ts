import { ipcMain, dialog, BrowserWindow, app, shell } from 'electron'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../../shared/ipc/channels'
import { WorkspaceService } from '../services/WorkspaceService'
import { RecentProjectsStore } from '../services/RecentProjectsStore'
import type { WorkspaceInfo } from '../../shared/types/workspace'
import { PermissionRuleStore } from '../services/PermissionRuleStore'

let recentStore: RecentProjectsStore | null = null
let currentWorkspaceService: WorkspaceService | null = null

export function getRecentStore(): RecentProjectsStore {
  if (!recentStore) {
    recentStore = new RecentProjectsStore()
    recentStore.load()
  }
  return recentStore
}

export function getWorkspaceService(): WorkspaceService | null {
  return currentWorkspaceService
}

export function registerWorkspaceIpc(): void {
  const store = getRecentStore()

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
      const service = currentWorkspaceService?.getCurrentWorkspace() === rootPath ? currentWorkspaceService : new WorkspaceService(rootPath)
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

  ipcMain.handle(IPC_CHANNELS.DETECT_PROJECT, async (_event, rootPath: string) => {
    try {
      const service = new WorkspaceService(rootPath)
      return await service.detectProjectType()
    } catch (error) {
      return { type: 'unknown' }
    }
  })

  ipcMain.handle(IPC_CHANNELS.GET_RECENT_PROJECTS, async (): Promise<WorkspaceInfo[]> => {
    return store.getAll()
  })

  ipcMain.handle(IPC_CHANNELS.ADD_RECENT_PROJECT, async (_event, project: WorkspaceInfo): Promise<void> => {
    await store.add(project)
  })

  ipcMain.handle(IPC_CHANNELS.REMOVE_RECENT_PROJECT, async (_event, id: string): Promise<void> => {
    await store.remove(id)
  })

  ipcMain.handle('workspace:open-in-explorer', async (_event, rootPath: string): Promise<boolean> => {
    try {
      await shell.openPath(rootPath)
      return true
    } catch (error) {
      console.error('Failed to open path in explorer:', error)
      return false
    }
  })

  
  ipcMain.handle('workspace:update-project', async (_event, project: WorkspaceInfo): Promise<void> => {
    await store.updateProject(project)
  })

  
  ipcMain.handle('permissions:addRule', async (_event, rule: string, scope: 'session' | 'global') => {
    await PermissionRuleStore.getInstance().addRule(rule, scope)
  })

  ipcMain.handle('workspace:rename-recent-project', async (_event, id: string, newName: string): Promise<void> => {
    await store.rename(id, newName)
  })

  const editorDefinitions = [
    { id: 'VSCode', name: 'VSCode', cmd: 'code', winDirs: ['Microsoft VS Code'], exe: 'Code.exe' },
    { id: 'Cursor', name: 'Cursor', cmd: 'cursor', winDirs: ['cursor'], exe: 'Cursor.exe' },
    { id: 'IntelliJ IDEA', name: 'IntelliJ IDEA', cmd: 'idea', winDirs: ['JetBrains/IntelliJ IDEA'], exe: 'bin/idea64.exe', backupCmd: 'idea64' },
    { id: 'PyCharm', name: 'PyCharm', cmd: 'pycharm', winDirs: ['JetBrains/PyCharm'], exe: 'bin/pycharm64.exe', backupCmd: 'pycharm64' },
    { id: 'WebStorm', name: 'WebStorm', cmd: 'webstorm', winDirs: ['JetBrains/WebStorm'], exe: 'bin/webstorm64.exe', backupCmd: 'webstorm64' },
    { id: 'CLion', name: 'CLion', cmd: 'CLion', winDirs: ['JetBrains/CLion'], exe: 'bin/clion64.exe', backupCmd: 'clion64' },
    { id: 'Sublime Text', name: 'Sublime Text', cmd: 'subl', winDirs: ['Sublime Text'], exe: 'sublime_text.exe' },
    { id: 'Android Studio', name: 'Android Studio', cmd: 'studio', winDirs: ['Android/Android Studio', 'Android Studio'], exe: 'bin/studio64.exe', backupCmd: 'studio64' },
    { id: 'HBuilderX', name: 'HBuilderX', cmd: 'hbuilderx', winDirs: ['HBuilderX'], exe: 'HBuilderX.exe' },
    { id: 'Eclipse', name: 'Eclipse', cmd: 'eclipse', winDirs: ['eclipse'], exe: 'eclipse.exe' }
  ]

  ipcMain.handle('workspace:open-in-editor', async (_event, rootPath: string, editorId: string, exePath: string | null): Promise<boolean> => {
    return new Promise((resolve) => {
      let command = ''
      
      if (exePath) {
        command = `"${exePath}" "${rootPath}"`
      } else {
        const def = editorDefinitions.find(d => d.id === editorId)
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
  })

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
        const filesInDir = entries.filter(e => e.isFile()).map(e => e.name)
        // 按照 targetNames 传进来的严格优先级顺序寻找
        for (const targetName of targetNames) {
          const match = filesInDir.find(name => name.toLowerCase() === targetName)
          if (match) {
            return path.join(currentPath, match)
          }
        }

        for (const entry of entries) {
          // 对于可能引发性能问题的目录予以屏蔽，比如 node_modules
          if (entry.isDirectory() && entry.name !== 'node_modules' && depth < maxDepth) {
            queue.push({ currentPath: path.join(currentPath, entry.name), depth: depth + 1 })
          }
        }
      } catch {
        // 忽略无权限或访问异常的目录
      }
    }
    return null
  }

  function getLocalEditorIcon(exePath: string, id: string): string | null {
    try {
      // 1. 设置应用级别的缓存目录
      const cacheDir = path.join(app.getPath('userData'), 'ide-icons')
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true })
      }

      // 2. 尝试从缓存直接读取 (秒开)
      const cachedIco = path.join(cacheDir, `${id}.ico`)
      const cachedPng = path.join(cacheDir, `${id}.png`)
      const cachedSvg = path.join(cacheDir, `${id}.svg`)
      
      // 优先取 PNG/SVG 缓存
      let cachedFile = [cachedPng, cachedSvg, cachedIco].find(f => fs.existsSync(f))
      
      // 【修复补丁】如果之前系统里错误地缓存了 VSCode 或 Cursor 的纯 .ico（导致 Chromium 白图），将其作废删除，强制触发 PNG 优先的全新深度扫描！
      if (cachedFile === cachedIco && (id === 'VSCode' || id === 'Cursor')) {
        try { fs.unlinkSync(cachedIco) } catch (e) {}
        cachedFile = undefined
      }

      if (cachedFile) {
        const fileData = fs.readFileSync(cachedFile)
        const ext = path.extname(cachedFile).toLowerCase()
        if (ext === '.svg') return `data:image/svg+xml;base64,${fileData.toString('base64')}`
        if (ext === '.png') return `data:image/png;base64,${fileData.toString('base64')}`
        if (ext === '.ico') return `data:image/x-icon;base64,${fileData.toString('base64')}`
      }

      // 3. 缓存没有，准备执行深度搜索
      const binDir = path.dirname(exePath)
      const parentDir = path.dirname(binDir)
      // 如果 exePath 是 bin/code.cmd，那么 binDir 就是 bin/。必须从 parentDir 开始搜索才能涵盖全局的 resources/ 目录！
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
      else if (id === 'Cursor') baseName = 'code' // 注意 Cursor 的内部物理图标名字往往复用了 code.ico (从截图可看出)
      
      if (!baseName) return null

      // 定义要匹配的文件名池，优先级从高到低！强烈优先高分辨率的 .png 和 .svg！
      const targetNames = [
        `${baseName}_150x150.png`,
        `${baseName}_70x70.png`,
        `${baseName}.png`, 
        `${baseName}.svg`, 
        `${baseName}.ico`, 
        'app.ico', 
        'icon.ico'
      ].map(n => n.toLowerCase())

      // 绝杀补丁：直接注入目标快捷路径进行优先极速探测，避免在不可见或受限目录下的 BFS 迷失。
      const fastPaths = [
        path.join(searchRoot, 'resources', 'win32'),
        path.join(searchRoot, 'resources', 'app', 'resources', 'win32'),
        path.join(binDir, '..', '..'), // 从 Cursor 的 bin 回退到主程序目录
        path.join(binDir, '..'),       // 从 VSCode 的 bin 回退到主程序目录
        path.dirname(exePath)
      ]

      let foundFile: string | null = null
      for (const fp of fastPaths) {
        if (!fs.existsSync(fp)) continue
        try {
          const entries = fs.readdirSync(fp, { withFileTypes: true })
          const filesInDir = entries.filter(e => e.isFile()).map(e => e.name)
          for (const targetName of targetNames) {
            const match = filesInDir.find(name => name.toLowerCase() === targetName)
            if (match) {
              foundFile = path.join(fp, match)
              break
            }
          }
        } catch {}
        if (foundFile) break
      }
      
      // 如果快捷通道未找到，才退回到全局 BFS，最大下钻 8 层。
      if (!foundFile) {
        foundFile = findIconBfs(searchRoot, targetNames, 8)
      }
      
      if (!foundFile) return null

      // 4. 找到后，把它安全复制到我们的缓存目录，永久保存
      const ext = path.extname(foundFile).toLowerCase()
      const cachePath = path.join(cacheDir, `${id}${ext}`)
      try {
        fs.copyFileSync(foundFile, cachePath)
      } catch (e) {
        console.warn('缓存图标写入失败', e)
      }

      // 5. 返回极清 Base64 数据流给前端
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

  ipcMain.handle('workspace:detect-installed-editors', async (): Promise<Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }>> => {
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
    const localAppData = process.env.LOCALAPPDATA || (userProfile ? path.join(userProfile, 'AppData', 'Local') : '')
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    
    const searchBases = [
      localAppData ? path.join(localAppData, 'Programs') : '',
      programFiles,
      programFilesX86,
      userProfile
    ].filter(Boolean)

    const installed: Array<{ id: string; name: string; exePath: string | null; iconPath: string | null }> = []

    for (const def of editorDefinitions) {
      // 1. 先探测 PATH 环境变量里的绝对路径
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

      // 2. 物理扫描常规目录
      let foundPath: string | null = null
      for (const base of searchBases) {
        for (const dirName of def.winDirs) {
          if (dirName.startsWith('JetBrains/')) {
            const jbParent = path.join(base, 'JetBrains')
            if (fs.existsSync(jbParent)) {
              try {
                const subdirs = fs.readdirSync(jbParent)
                const targetSub = subdirs.find(s => s.toLowerCase().includes(dirName.split('/')[1].toLowerCase()))
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

    // 兜底保护
    if (installed.length === 0) {
      installed.push({ id: 'VSCode', name: 'VSCode', exePath: null, iconPath: null })
    }

    return installed
  })
}
