import React, { useState, useEffect } from 'react'
import { useProviderStore } from '../stores/providerStore'
import SettingsPanel from '../components/SettingsPanel'
import { IconSettings, IconServer, IconSkills, IconCode, IconAdd, IconArrowLeft, IconTrash, IconBook, IconZap } from '../components/Icons'
import Flex from '../components/ui/Flex'
import Stack from '../components/ui/Stack'
import Card from '../components/ui/Card'
import TrashPanel from '../components/TrashPanel'
import SettingsSkillsTab from '../components/SettingsSkillsTab'
import SettingsRulesTab from '../components/SettingsRulesTab'
import SettingsAgentsTab from '../components/SettingsAgentsTab'
import SettingsGeneralTab from '../components/SettingsGeneralTab'
import './SettingsPage.css'

interface Props {
  onBack: () => void
  initialTab?: string
}

// 侧边栏菜单项配置 - 仅保留排期内需要的核心模块
const GLOBAL_MENU_ITEMS = [
  { id: 'general', label: '常规', icon: <IconSettings /> },
  { id: 'code-preview', label: '代码预览', icon: <IconCode /> },
  { id: 'model-config', label: '模型设置', icon: <IconServer /> },
  { id: 'agents', label: '智能体', icon: <IconZap /> },
  { id: 'skills', label: '技能', icon: <IconSkills /> },
  { id: 'rules', label: '规则', icon: <IconBook /> },
  { id: 'trash', label: '最近删除', icon: <IconTrash /> },
]

export default function SettingsPage({ onBack, initialTab }: Props): React.ReactElement {
  // Provider 相关的 state
  const providers = useProviderStore((s) => s.providers)
  const activeProviderId = useProviderStore((s) => s.activeProviderId)
  const loadProviders = useProviderStore((s) => s.loadProviders)
  const addProvider = useProviderStore((s) => s.addProvider)
  const updateProvider = useProviderStore((s) => s.updateProvider)
  const removeProvider = useProviderStore((s) => s.removeProvider)
  const testConnection = useProviderStore((s) => s.testConnection)
  const setActiveProvider = useProviderStore((s) => s.setActiveProvider)



  // 面板控制状态
  const [activeGlobalMenu, setActiveGlobalMenu] = useState(initialTab || 'general')
  const [activeTabId, setActiveTabId] = useState<string | 'new' | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; message: string }>>({})

  useEffect(() => {
    loadProviders().then(() => {
      const currentProviders = useProviderStore.getState().providers
      if (currentProviders.length > 0) {
        setActiveTabId(useProviderStore.getState().activeProviderId || currentProviders[0].id)
      } else {
        setActiveTabId('new')
      }
    })
  }, [])

  const handleTest = async (id: string) => {
    setTestResult((prev) => ({ ...prev, [id]: { success: false, message: '测试中...' } }))
    const result = await testConnection(id)
    setTestResult((prev) => ({ ...prev, [id]: result }))
  }

  const activeProvider = providers.find(p => p.id === activeTabId)

  // MainArea 依据选中的 Tab 不同渲染不同内容
  const renderMainAreaContent = () => {
    if (activeGlobalMenu === 'model-config') {
      return (
        <Flex className="settings-content-wrapper">
          {/* 中间 - 提供商列表层 */}
          <Stack className="settings-provider-sidebar">
            <div className="settings-provider-header">
              <h1 className="settings-provider-title">模型设置</h1>
              <p className="settings-provider-desc">管理自定义模型供应商，配置后可在聊天时选择使用。</p>
            </div>
            
            <Stack className="settings-provider-list-container">
              <div className="settings-provider-group-label">自定义供应商</div>
              <Stack gap={1}>
                {providers.map((p) => (
                  <Flex
                    key={p.id}
                    align="center"
                    justify="between"
                    onClick={() => {
                      setActiveTabId(p.id)
                      if(activeProviderId !== p.id) {
                        setActiveProvider(p.id)
                      }
                    }}
                    className={`settings-provider-item ${
                      activeTabId === p.id 
                        ? 'active' 
                        : 'inactive'
                    }`}
                  >
                    <Flex align="center" gap={2.5} className="min-w-0">
                      <span className="shrink-0">
                        <IconServer className="btn-icon"/>
                      </span>
                      <span className="truncate">{p.name}</span>
                    </Flex>
                    {p.id === activeProviderId && (
                      <span className="settings-provider-dot" />
                    )}
                  </Flex>
                ))}

                <Flex
                  align="center"
                  gap={2.5}
                  onClick={() => setActiveTabId('new')}
                  className={`settings-provider-item ${
                    activeTabId === 'new' 
                      ? 'active' 
                      : 'inactive'
                  }`}
                  style={{ marginTop: '8px' }}
                >
                  <span className="shrink-0">
                    <IconAdd />
                  </span>
                  <span>添加供应商</span>
                </Flex>
              </Stack>
            </Stack>
          </Stack>

          {/* 右侧 - 详情配置区 */}
          {activeTabId === 'new' ? (
            <SettingsPanel
              initialData={{ name: '', baseUrl: '', apiKey: '', models: [], thinking: { enabled: true, mode: 'openai' } }}
              isNew={true}
              onSave={async (data) => {
                const newProv = await addProvider(data)
                setActiveTabId(newProv.id)
                if(!activeProviderId) {
                  setActiveProvider(newProv.id)
                }
              }}
            />
          ) : activeProvider ? (
            <SettingsPanel
              key={activeProvider.id}
              initialData={{
                name: activeProvider.name,
                baseUrl: activeProvider.baseUrl,
                apiFormat: activeProvider.apiFormat,
                apiKey: activeProvider.apiKey,
                models: activeProvider.models,
                thinking: activeProvider.thinking || { enabled: true, mode: 'openai' }
              }}
              isNew={false}
              onSave={async (data) => await updateProvider(activeProvider.id, data)}
              onDelete={async () => {
                 await removeProvider(activeProvider.id)
                 const remain = useProviderStore.getState().providers
                 setActiveTabId(remain.length > 0 ? remain[0].id : 'new')
              }}
              onTest={() => handleTest(activeProvider.id)}
              testResult={testResult[activeProvider.id]}
            />
          ) : (
            <Flex align="center" justify="center" className="settings-empty-pane">
              请选择一个供应商进行配置
            </Flex>
          )}
        </Flex>
      )
    }

    if (activeGlobalMenu === 'general') {
      return <SettingsGeneralTab />
    }

    if (activeGlobalMenu === 'trash') {
      return <TrashPanel />
    }

    if (activeGlobalMenu === 'skills') {
      return <SettingsSkillsTab />
    }

    if (activeGlobalMenu === 'agents') {
      return <SettingsAgentsTab />
    }

    if (activeGlobalMenu === 'rules') {
      return <SettingsRulesTab />
    }

    // 其它通用的占位面板区域
    const menuItem = GLOBAL_MENU_ITEMS.find(i => i.id === activeGlobalMenu)
    return (
      <Stack align="center" justify="center" className="settings-placeholder-pane" gap={2}>
        <Flex align="center" justify="center" className="settings-placeholder-icon-box">
          {menuItem?.icon}
        </Flex>
        <h2 className="settings-placeholder-title">{menuItem?.label}</h2>
        <p>该设置面板尚未实现具体功能。</p>
      </Stack>
    )
  }

  return (
    <Flex className="settings-layout">
      
      {/* 1. 最左侧一级全局导航 Sidebar */}
      <Stack className="settings-nav-sidebar">
        
        {/* 返回按钮 */}
        <div className="settings-back-container">
          <Flex 
            align="center"
            gap={2}
            className="settings-back-btn"
            onClick={onBack}
          >
            <IconArrowLeft />
            <span className="settings-back-text">返回工作区</span>
          </Flex>
        </div>

        {/* 一级菜单列表 */}
        <Stack className="settings-nav-list" gap="4px">
          {GLOBAL_MENU_ITEMS.map((item) => (
            <Flex 
              key={item.id}
              align="center"
              gap={3}
              onClick={() => setActiveGlobalMenu(item.id)}
              className={`settings-nav-item ${
                activeGlobalMenu === item.id 
                  ? 'active' 
                  : 'inactive'
              }`}
            >
              <span className="shrink-0">{item.icon}</span>
              <span>{item.label}</span>
            </Flex>
          ))}
        </Stack>
      </Stack>

      {/* 2. 右侧 MainArea 舞台 */}
      {renderMainAreaContent()}
      
    </Flex>
  )
}