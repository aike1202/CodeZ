import React from 'react'
import Button from '../../ui/Button'
import Flex from '../../ui/Flex'
import Card from '../../ui/Card'
import IconChevronDown from '../../icons/IconChevronDown'
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
    ? `${activeProvider.name} / ${selectedModelName || activeProvider.models[0]?.name || '?'}`
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
                <div key={p.id}>
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
                    <span>{p.name}</span>
                    {p.id === activeProviderId && <span className="prompt-check-mark">✓</span>}
                  </Flex>
                  {p.id === activeProviderId && p.models.length > 0 && (
                    <div className="prompt-dropdown-model-list">
                      {p.models.map((m: any) => (
                        <Flex
                          key={m.id}
                          align="center"
                          justify="between"
                          className={`prompt-dropdown-model-item ${
                            selectedModelName === m.name ? 'is-selected' : ''
                          }`}
                          onClick={() => {
                            setSelectedModelName(m.name)
                            setIsOpen(false)
                          }}
                        >
                          <span>{m.name}</span>
                          <span className="prompt-model-context-tokens">
                            {m.maxContextTokens > 0 ? `${(m.maxContextTokens / 1024).toFixed(0)}K` : '-'}
                          </span>
                        </Flex>
                      ))}
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
