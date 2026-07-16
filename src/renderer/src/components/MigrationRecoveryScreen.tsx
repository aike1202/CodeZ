import React, { useMemo, useState } from 'react'
import type {
  MigrationCredentialInput,
  MigrationCredentialRequirement,
  MigrationRecoveryStatus,
} from '../shared/desktop'
import './MigrationRecoveryScreen.css'

interface Props {
  status: MigrationRecoveryStatus
  onSubmit: (inputs: MigrationCredentialInput[]) => Promise<void>
  onRestart: () => Promise<void>
}

const DATA_SET_LABELS: Record<MigrationCredentialRequirement['dataSet'], string> = {
  providers: '模型提供商',
  mcpSecrets: 'MCP 密钥',
  mcpOAuth: 'MCP OAuth',
}

const REASON_LABELS: Record<NonNullable<MigrationCredentialRequirement['reason']>, string> = {
  missingCredential: '旧记录缺少凭据值',
  insecureLegacyEncoding: '旧凭据未使用可验证的安全存储格式',
  invalidLegacyDocument: '旧凭据记录无法安全解析',
  invalidIdentifier: '旧记录没有可安全映射的凭据标识',
  unsupportedPlatform: '当前系统无法读取旧安全存储',
  localStateUnavailable: '旧安全存储状态不可用',
  invalidLocalState: '旧安全存储状态无效',
  keyUnavailable: '旧安全存储密钥不可用',
  invalidEncoding: '旧凭据编码无效',
  unsupportedEnvelope: '旧凭据加密封装不受支持',
  authenticationFailed: '旧凭据校验失败',
  invalidPlaintext: '旧凭据内容无效',
}

export default function MigrationRecoveryScreen({
  status,
  onSubmit,
  onRestart,
}: Props): React.ReactElement {
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputRequirements = useMemo(
    () => status.requirements.filter((requirement) => requirement.canReenter && requirement.credentialId),
    [status.requirements],
  )
  const blockedRequirements = useMemo(
    () => status.requirements.filter((requirement) => !requirement.canReenter),
    [status.requirements],
  )
  const canSubmit = blockedRequirements.length === 0
    && inputRequirements.length > 0
    && inputRequirements.every((requirement) => Boolean(values[requirement.credentialId!]))

  const submit = async (): Promise<void> => {
    if (!canSubmit || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(inputRequirements.map((requirement) => ({
        credentialId: requirement.credentialId!,
        secret: values[requirement.credentialId!],
      })))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法继续迁移')
    } finally {
      setValues({})
      setSubmitting(false)
    }
  }

  const restart = async (): Promise<void> => {
    if (restarting) return
    setRestarting(true)
    setError(null)
    try {
      await onRestart()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法重启应用')
      setRestarting(false)
    }
  }

  if (status.phase === 'readyToRestart') {
    return (
      <main className="migration-recovery-screen" aria-live="polite">
        <section className="migration-recovery-panel">
          <h1>迁移已完成</h1>
          <p>凭据已写入系统安全存储，重启后将加载迁移后的数据。</p>
          {error ? <p className="migration-recovery-error" role="alert">{error}</p> : null}
          <button
            className="migration-recovery-primary"
            type="button"
            onClick={() => void restart()}
            disabled={restarting}
          >
            {restarting ? '正在重启...' : '重启应用'}
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className="migration-recovery-screen" aria-live="polite">
      <section className="migration-recovery-panel">
        <h1>需要重新输入凭据</h1>
        <p>迁移将在所有凭据经过验证并安全保存后继续。</p>
        <div className="migration-recovery-list">
          {inputRequirements.map((requirement) => {
            const credentialId = requirement.credentialId!
            return (
              <label className="migration-recovery-field" key={credentialId}>
                <span className="migration-recovery-field-title">
                  {DATA_SET_LABELS[requirement.dataSet]}
                </span>
                <span className="migration-recovery-field-meta">{credentialId}</span>
                {requirement.reason ? (
                  <span className="migration-recovery-field-reason">
                    {REASON_LABELS[requirement.reason]}
                  </span>
                ) : null}
                <input
                  autoComplete="off"
                  type="password"
                  value={values[credentialId] ?? ''}
                  onChange={(event) => setValues((current) => ({
                    ...current,
                    [credentialId]: event.target.value,
                  }))}
                />
              </label>
            )
          })}
          {blockedRequirements.map((requirement) => (
            <div className="migration-recovery-blocked" key={`${requirement.dataSet}-${requirement.sourceIndex}`}>
              <span>{DATA_SET_LABELS[requirement.dataSet]}</span>
              <span>{requirement.reason ? REASON_LABELS[requirement.reason] : '旧记录无法安全映射'}</span>
            </div>
          ))}
        </div>
        {error ? <p className="migration-recovery-error" role="alert">{error}</p> : null}
        <button
          className="migration-recovery-primary"
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit || submitting}
        >
          {submitting ? '正在验证...' : '继续迁移'}
        </button>
      </section>
    </main>
  )
}
