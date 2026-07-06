import React, { useEffect } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import type { GeneralSettings } from '@shared/types/settings'
import Switch from '../ui/Switch'
import Select from '../ui/Select'
import Input from '../ui/Input'
import Button from '../ui/Button'
import './SettingsGeneralTab.css'
import { PermissionSettingsSection } from './components/PermissionSettingsSection'

export default function SettingsGeneralTab(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const loading = useSettingsStore((s) => s.loading)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

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
            <Select
              value={settings.appTheme}
              onChange={(e) => {
                const val = e.target.value
                handleUpdate('appTheme', val)
                if (window.api?.theme) {
                  window.api.theme.set(val as any)
                }
              }}
            >
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
            <Switch
              checked={settings.inheritTerminalProfile}
              onChange={(val) => handleUpdate('inheritTerminalProfile', val)}
            />
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
            <Switch
              checked={settings.notificationSounds}
              onChange={(val) => handleUpdate('notificationSounds', val)}
            />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">关闭窗口时隐藏到托盘</div>
            <div className="settings-general-desc">点击关闭按钮时隐藏窗口，托盘中可完全退出应用。</div>
          </div>
          <div className="settings-general-control">
            <Switch
              checked={settings.hideToTrayOnClose}
              onChange={(val) => handleUpdate('hideToTrayOnClose', val)}
            />
          </div>
        </div>
      </div>

      {/* 4. 交互与数据 */}
      <div className="settings-general-card">
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">显示思考过程</div>
            <div className="settings-general-desc">在消息流中展示模型思考内容。</div>
          </div>
          <div className="settings-general-control">
            <Switch
              checked={settings.showThinkingProcess}
              onChange={(val) => handleUpdate('showThinkingProcess', val)}
            />
          </div>
        </div>
        <div className="settings-general-row">
          <div>
            <div className="settings-general-label">数据存储路径</div>
            <div className="settings-general-desc">应用数据的根目录。</div>
          </div>
          <div className="settings-general-control" style={{ gap: '8px' }}>
            <Input disabled value={settings.dataStoragePath || '默认路径'} />
            <Button type="default" size="sm" onClick={() => alert('暂未实现更改路径功能')}>
              更改
            </Button>
          </div>
        </div>
      </div>

      {/* 5. 权限说明 */}
      <PermissionSettingsSection workspaceMode={settings.workspaceMode} onUpdate={handleUpdate} />

      {/* 6. 联网搜索 */}
      <WebSearchSettingsSection settings={settings} onUpdate={handleUpdate} />
    </div>
  )
}

interface WebSearchSectionProps {
  settings: GeneralSettings
  onUpdate: (key: keyof GeneralSettings, value: any) => void
}

function WebSearchSettingsSection({ settings, onUpdate }: WebSearchSectionProps): React.ReactElement {
  const ws = settings.webSearch
  const [domainInput, setDomainInput] = React.useState('')

  const updateWs = (patch: Partial<typeof ws>) => {
    onUpdate('webSearch', { ...ws, ...patch })
  }
  const updateEngine = (key: keyof typeof ws.engines, val: boolean) => {
    updateWs({ engines: { ...ws.engines, [key]: val } })
  }
  const addDomain = () => {
    const d = domainInput.trim()
    if (!d || ws.blockedDomains.includes(d)) return
    updateWs({ blockedDomains: [...ws.blockedDomains, d] })
    setDomainInput('')
  }
  const removeDomain = (d: string) => {
    updateWs({ blockedDomains: ws.blockedDomains.filter((x) => x !== d) })
  }

  return (
    <div className="settings-general-card">
      <div className="settings-general-row">
        <div>
          <div className="settings-general-label">联网搜索</div>
          <div className="settings-general-desc">允许模型联网搜索并抓取网页内容。</div>
        </div>
        <div className="settings-general-control">
          <Switch checked={ws.enabled} onChange={(val) => updateWs({ enabled: val })} />
        </div>
      </div>

      {ws.enabled && (
        <>
          <div className="settings-general-row">
            <div>
              <div className="settings-general-label">搜索引擎</div>
              <div className="settings-general-desc">百度 / 掘金 / CSDN，国内直连，无需代理。</div>
            </div>
            <div className="settings-general-control" style={{ gap: '16px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Switch checked={ws.engines.baidu} onChange={(v) => updateEngine('baidu', v)} />
                <span>百度</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Switch checked={ws.engines.juejin} onChange={(v) => updateEngine('juejin', v)} />
                <span>掘金</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Switch checked={ws.engines.csdn} onChange={(v) => updateEngine('csdn', v)} />
                <span>CSDN</span>
              </label>
            </div>
          </div>

          <div className="settings-general-row">
            <div>
              <div className="settings-general-label">排除站点</div>
              <div className="settings-general-desc">搜索结果中排除这些域名（子串匹配）。</div>
            </div>
            <div className="settings-general-control" style={{ gap: '8px' }}>
              <Input
                placeholder="如: example.com"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addDomain()
                }}
              />
              <Button type="default" size="sm" onClick={addDomain}>
                添加
              </Button>
            </div>
          </div>

          {ws.blockedDomains.length > 0 && (
            <div className="settings-general-row">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', width: '100%' }}>
                {ws.blockedDomains.map((d) => (
                  <span
                    key={d}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      background: 'var(--color-bg-secondary, #2a2a2a)',
                      fontSize: '12px'
                    }}
                  >
                    {d}
                    <span style={{ cursor: 'pointer', opacity: 0.6 }} onClick={() => removeDomain(d)}>
                      ✕
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
