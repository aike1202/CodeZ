import React, { useEffect } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import Switch from './ui/Switch'
import Select from './ui/Select'
import Input from './ui/Input'
import Button from './ui/Button'
import './SettingsGeneralTab.css'

export default function SettingsGeneralTab(): React.ReactElement {
  const settings = useSettingsStore(s => s.settings)
  const loading = useSettingsStore(s => s.loading)
  const loadSettings = useSettingsStore(s => s.loadSettings)
  const updateSettings = useSettingsStore(s => s.updateSettings)

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  if (loading || !settings) {
    return <div className="settings-general-wrapper">加载中...</div>
  }

  const handleUpdate = (key: keyof typeof settings, value: any) => {
    updateSettings({ [key]: value })
  }

  return (
    <div className="settings-general-wrapper">
      <h2 className="settings-general-title">常规设置</h2>

      {/* 1. 外观与显示 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">界面主题</div>
            <div className="settings-general-desc">切换应用界面使用的主题外观。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.appTheme} onChange={(e) => {
              const val = e.target.value
              handleUpdate('appTheme', val)
              if (window.api?.theme) {
                window.api.theme.set(val as any)
              }
            }}>
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">界面语言</div>
            <div className="settings-general-desc">选择应用 UI 的显示语言。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.language} onChange={(e) => handleUpdate('language', e.target.value)}>
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">代码编辑器主题</div>
            <div className="settings-general-desc">设置代码预览区的高亮主题。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.editorTheme} onChange={(e) => handleUpdate('editorTheme', e.target.value)}>
              <option value="github">Github (Light)</option>
              <option value="dracula">Dracula (Dark)</option>
              <option value="material">Material (Dark)</option>
              <option value="xcode">Xcode (Light)</option>
              <option value="eclipse">Eclipse (Light)</option>
            </Select>
          </div>
        </div>
      </div>

      {/* 2. 终端与网络 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">继承系统终端 Profile</div>
            <div className="settings-general-desc">启动内置终端时尽量继承登录 shell 环境。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.inheritTerminalProfile} onChange={(val) => handleUpdate('inheritTerminalProfile', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">集成终端 Shell</div>
            <div className="settings-general-desc">选择在内置终端使用的 Shell 类型。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.terminalShell} onChange={(e) => handleUpdate('terminalShell', e.target.value)}>
              <option value="auto">自动选择</option>
              <option value="bash">Bash</option>
              <option value="cmd">CMD</option>
              <option value="powershell">PowerShell</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">终端字体</div>
            <div className="settings-general-desc">留空时自动继承系统等宽字体。</div>
          </div>
          <div className="settings-general-control">
            <Input 
              placeholder="如: MesloLGS NF" 
              value={settings.terminalFont} 
              onChange={(e) => handleUpdate('terminalFont', e.target.value)} 
            />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">HTTP 代理</div>
            <div className="settings-general-desc">留空直连，修改后需重启应用生效。</div>
          </div>
          <div className="settings-general-control">
            <Input 
              placeholder="http://127.0.0.1:7890" 
              value={settings.httpProxy} 
              onChange={(e) => handleUpdate('httpProxy', e.target.value)} 
            />
          </div>
        </div>
      </div>

      {/* 3. 系统与通知 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">任务通知</div>
            <div className="settings-general-desc">任务完成、失败或需要确认时发送桌面通知。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.taskNotifications} onChange={(val) => handleUpdate('taskNotifications', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">通知声音</div>
            <div className="settings-general-desc">开启通知提示音。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.notificationSounds} onChange={(val) => handleUpdate('notificationSounds', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">关闭窗口时隐藏到托盘</div>
            <div className="settings-general-desc">点击关闭按钮时隐藏窗口，托盘中可完全退出应用。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.hideToTrayOnClose} onChange={(val) => handleUpdate('hideToTrayOnClose', val)} />
          </div>
        </div>
      </div>

      {/* 4. 交互与偏好 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">交互行为</div>
            <div className="settings-general-desc">在运行时将后续操作加入队列，或引导至下一轮。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.interactionBehavior} onChange={(e) => handleUpdate('interactionBehavior', e.target.value)}>
              <option value="queue">队列</option>
              <option value="immediate">立即执行</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">显示思考过程</div>
            <div className="settings-general-desc">在消息流中展示模型思考内容。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.showThinkingProcess} onChange={(val) => handleUpdate('showThinkingProcess', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">显示待办</div>
            <div className="settings-general-desc">在消息流中展示 Todo 工具卡片。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.showTodoCards} onChange={(val) => handleUpdate('showTodoCards', val)} />
          </div>
        </div>
      </div>

      {/* 5. 数据与存储 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">自动归档旧任务</div>
            <div className="settings-general-desc">定时扫描最近打开过的工作区，自动归档旧任务。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.autoArchiveTasks} onChange={(val) => handleUpdate('autoArchiveTasks', val)} />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">归档保留时长</div>
            <div className="settings-general-desc">任务最后更新时间早于该时长后，才进入自动归档。</div>
          </div>
          <div className="settings-general-control">
            <Select value={settings.archiveRetentionDays.toString()} onChange={(e) => handleUpdate('archiveRetentionDays', parseInt(e.target.value))}>
              <option value="3">3 天后归档</option>
              <option value="7">7 天后归档</option>
              <option value="14">14 天后归档</option>
              <option value="30">30 天后归档</option>
            </Select>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">数据存储路径</div>
            <div className="settings-general-desc">应用数据的根目录。</div>
          </div>
          <div className="settings-general-control" style={{ gap: '8px' }}>
             <Input disabled value={settings.dataStoragePath || '默认路径'} />
             <Button type="default" size="sm" onClick={() => alert('暂未实现更改路径功能')}>更改</Button>
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">优化体验</div>
            <div className="settings-general-desc">允许我们将你的对话内容用于优化 Agent 的使用体验。</div>
          </div>
          <div className="settings-general-control">
            <Switch checked={settings.experienceOptimization} onChange={(val) => handleUpdate('experienceOptimization', val)} />
          </div>
        </div>
      </div>

    </div>
  )
}
