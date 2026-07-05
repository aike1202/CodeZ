import React from 'react'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import Card from '../../ui/Card'
import IconChevronDown from '../../icons/IconChevronDown'
import IconChevron from '../../icons/IconChevron'
import IconGear from '../../icons/IconGear'
import { useProviderStore } from '../../../stores/providerStore'

interface ModelSelectorProps {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  onOpenSettings?: () => void
  onCloseOthers: () => void
  selectedModelName: string
  setSelectedModelName: (modelName: string) => void
}

export default function ModelSelector({
  isOpen,
  setIsOpen,
  onOpenSettings,
  onCloseOthers,
  selectedModelName,
  setSelectedModelName
}: ModelSelectorProps): React.ReactElement {
  const providers = useProviderStore((s: any) => s.providers)
  const activeProviderId = useProviderStore((s: any) => s.activeProviderId)

  const activeProvider = providers.find((p: any) => p.id === activeProviderId)
  const displayLabel = activeProvider
    ? `${selectedModelName || activeProvider.models[0]?.name || '?'}`
    : '未配置模型'

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="none"
        className="prompt-model-selector-btn"
        onClick={() => {
          onCloseOthers()
          setIsOpen(!isOpen)
        }}
      >
        <span className="truncate">{displayLabel}</span>
        <IconChevronDown />
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-[40]" onClick={() => setIsOpen(false)}></div>
          <Card variant="default" className="prompt-dropdown-card">
            <div className="prompt-dropdown-header">Provider / 模型</div>

            {providers.length === 0 ? (
              <div className="prompt-dropdown-empty">暂无 Provider</div>
            ) : (
              providers.map((p: any) => (
                <div key={p.id} className="prompt-dropdown-provider-wrapper">
                  <Flex
                    align="center"
                    justify="between"
                    className={`prompt-dropdown-provider ${
                      p.id === activeProviderId ? 'is-active' : ''
                    }`}
                    onClick={() => {
                      useProviderStore.getState().setActiveProvider(p.id)
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span>{p.name}</span>
                      {p.id === activeProviderId && (selectedModelName || p.models?.[0]?.name) && (
                        <span className="prompt-provider-subtitle">
                          {selectedModelName || p.models?.[0]?.name}
                        </span>
                      )}
                    </div>
                    <Flex align="center" gap={2}>
                      {p.id === activeProviderId && <span className="prompt-check-mark">✓</span>}
                      {p.models && p.models.length > 0 && <IconChevron className="prompt-chevron-right" />}
                    </Flex>
                  </Flex>

                  {p.models && p.models.length > 0 && (
                    <div className="prompt-submenu-container">
                      <Card variant="default" className="prompt-submenu-card">
                        <div className="prompt-dropdown-model-list-submenu">
                          {p.models.map((m: any) => (
                            <Flex
                              key={m.id}
                              align="center"
                              justify="between"
                              className={`prompt-dropdown-model-item ${
                                selectedModelName === m.name ? 'is-selected' : ''
                              }`}
                              onClick={(e) => {
                                e.stopPropagation()
                                setSelectedModelName(m.name)
                                if (p.id !== activeProviderId) {
                                  useProviderStore.getState().setActiveProvider(p.id)
                                }
                                setIsOpen(false)
                              }}
                            >
                              <span>{m.name}</span>
                              {m.maxContextTokens > 0 && (
                                <span className="prompt-model-context-tokens">
                                  {`${m.maxContextTokens % 10000 === 0 ? m.maxContextTokens / 10000 : parseFloat((m.maxContextTokens / 10000).toFixed(2))}万`}
                                </span>
                              )}
                            </Flex>
                          ))}
                        </div>
                      </Card>
                    </div>
                  )}
                </div>
              ))
            )}

            {onOpenSettings && (
              <>
                <div className="prompt-dropdown-divider"></div>
                <Flex
                  align="center"
                  gap={2}
                  className="prompt-dropdown-settings-action"
                  onClick={() => {
                    setIsOpen(false)
                    onOpenSettings()
                  }}
                >
                  <IconGear /> 管理 Provider...
                </Flex>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
