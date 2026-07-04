import { useState, useMemo } from 'react'
import { Check, Pencil, RotateCcw } from 'lucide-react'
import './AskUserQuestionWidget.css'
import MarkdownDetail from './MarkdownDetail'
import type { AskUserRequestState } from '../../stores/chatStore'

/** 用户点击"忽略"时返回的哨兵值，与主进程 ASK_USER_IGNORED 保持一致 */
const ASK_USER_IGNORED = '__IGNORED__'

interface Props {
  msgId: string
  requests: AskUserRequestState[]
  onResolve: (msgId: string, requestId: string, answers: Array<{ question: string; answer: string | string[] }>) => void
}

export default function AskUserQuestionWidget({ msgId, requests, onResolve }: Props) {
  const pending = requests.filter((r) => r.status === 'pending')
  if (pending.length === 0) return null
  const req = pending[0]

  return (
    <div className="ask-user-widget">
      {req.questions.map((q, qi) => (
        <QuestionBlock
          key={qi}
          question={q}
          onSubmit={(answer) => {
            // 单问即整体答复；多问可扩展为收集全部后一次提交
            onResolve(msgId, req.id, [{ question: q.question, answer }])
          }}
        />
      ))}
    </div>
  )
}

type OptionLike = AskUserRequestState['questions'][number]['options'][number]

function QuestionBlock({ question, onSubmit }: {
  question: AskUserRequestState['questions'][number]
  onSubmit: (answer: string | string[]) => void
}) {
  const multiSelect = !!question.multiSelect
  const submitLabel = question.submitLabel?.trim() || '提交'
  const ignoreLabel = question.ignoreLabel?.trim() || '忽略'

  // 选中态：单选为 string[]（长度 0/1），多选为 string[]
  const [selected, setSelected] = useState<string[]>([])
  // 最近操作的选项 label —— 用于 detail 区显示哪一项的详情（多选时也只展示一项）
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [other, setOther] = useState('')
  const [showOther, setShowOther] = useState(false)
  const [otherError, setOtherError] = useState(false)

  // detail 在任一选项含非空 detail 时启用（单选/多选均生效）
  const hasDetail = useMemo(
    () => question.options.some((o) => typeof o.detail === 'string' && o.detail.trim().length > 0),
    [question.options]
  )

  // detail 区显示的选项：优先 activeLabel，其次唯一选中项，否则首个含 detail 的项
  const detailOption = useMemo<OptionLike | null>(() => {
    if (!hasDetail) return null
    const find = (label: string | null) => (label ? question.options.find((o) => o.label === label) || null : null)
    return find(activeLabel) || find(selected[0] || null) || question.options.find((o) => o.detail) || null
  }, [hasDetail, activeLabel, selected, question.options])

  const isSelected = (label: string) => selected.includes(label)

  const buildAnswer = (): string | string[] | null => {
    if (showOther) {
      const text = other.trim()
      if (!text && selected.filter((l) => l !== '__other__').length === 0) return null
      if (multiSelect) {
        const ans = selected.filter((l) => l !== '__other__')
        if (text) ans.push(text)
        return ans
      }
      // 单选 + 其他：必须有文本
      if (!text) return null
      return text
    }
    if (selected.length === 0) return null
    return multiSelect ? selected : selected[0]
  }

  // 选项点击：
  //  - 单选：点未选中项 → 选中；点已选中项 → 确认提交（双击确认）
  //  - 多选：点 → 勾选/取消，不提交
  const toggle = (label: string) => {
    setOtherError(false)
    setActiveLabel(label)
    if (multiSelect) {
      setSelected((prev) => (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]))
      return
    }
    // 单选：已选中同一项 → 提交
    if (selected.length === 1 && selected[0] === label) {
      onSubmit(label)
      return
    }
    // 否则选中该项
    setSelected([label])
  }

  // "其他"选项点击：
  //  - 单选：未展开 → 展开+选中；已展开且为当前选中 → 再次点击确认提交（需文本非空）
  //  - 多选：展开/收起输入框
  const toggleOther = () => {
    setOtherError(false)
    setActiveLabel('__other__')
    if (multiSelect) {
      setShowOther((v) => {
        if (v) {
          setOther('')
          setSelected((prev) => prev.filter((l) => l !== '__other__'))
        }
        return !v
      })
      return
    }
    // 单选
    if (!showOther) {
      // 首次：展开 + 选中 other
      setShowOther(true)
      setSelected(['__other__'])
      return
    }
    // 已展开：若 other 是当前选中项 → 确认提交
    if (selected.length === 1 && selected[0] === '__other__') {
      const text = other.trim()
      if (!text) {
        setOtherError(true)
        return
      }
      onSubmit(text)
      return
    }
    // 否则切回选中 other
    setSelected(['__other__'])
  }

  // 是否有可提交的内容（用于提交按钮 disabled）
  const canSubmit = useMemo(() => buildAnswer() !== null, [selected, showOther, other, multiSelect])

  const handleSubmit = () => {
    const ans = buildAnswer()
    if (ans === null) {
      setOtherError(true)
      return
    }
    onSubmit(ans)
  }

  const handleIgnore = () => {
    onSubmit(multiSelect ? [ASK_USER_IGNORED] : ASK_USER_IGNORED)
  }

  const renderOption = (opt: OptionLike) => {
    const sel = isSelected(opt.label)
    return (
      <button
        key={opt.label}
        type="button"
        role="option"
        aria-selected={sel}
        className={`ask-user-option${sel ? ' selected' : ''}${activeLabel === opt.label ? ' active' : ''}`}
        onClick={() => toggle(opt.label)}
      >
        {/* 多选才显示勾选图标；单选仅靠描边高亮表达选中 */}
        {multiSelect && (
          <span className="ask-user-option-check" aria-hidden="true">
            {sel && <Check size={14} />}
          </span>
        )}
        <span className="ask-user-option-body">
          <span className="ask-user-option-label">{opt.label}</span>
          {opt.description && <span className="ask-user-option-desc">{opt.description}</span>}
        </span>
      </button>
    )
  }

  const renderOtherOption = () => {
    const sel = multiSelect ? showOther : selected.includes('__other__')
    return (
      <div className={`ask-user-option ask-user-option-other${sel ? ' selected' : ''}${showOther ? ' expanded' : ''}`}>
        <button
          type="button"
          role="option"
          aria-selected={sel}
          className="ask-user-option-main"
          onClick={toggleOther}
        >
          {multiSelect && (
            <span className="ask-user-option-check" aria-hidden="true">
              {sel ? <Check size={14} /> : <Pencil size={13} />}
            </span>
          )}
          {!multiSelect && sel && (
            <span className="ask-user-option-check" aria-hidden="true">
              <Pencil size={13} />
            </span>
          )}
          <span className="ask-user-option-body">
            <span className="ask-user-option-label">其他</span>
          </span>
        </button>
        {showOther && (
          <textarea
            className={`ask-user-other-input${otherError ? ' has-error' : ''}`}
            placeholder={multiSelect ? '输入自定义答案（可与其他项组合）' : '输入自定义答案，回车提交'}
            value={other}
            rows={2}
            onChange={(e) => {
              setOther(e.target.value)
              setOtherError(false)
              // 自动增高：跟随内容调整高度，上限 5 行
              const el = e.target
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 120)}px`
            }}
            onKeyDown={(e) => {
              // 单选：Enter 提交（Shift+Enter 换行）；多选：仅 Shift+Enter 换行
              if (e.key === 'Enter' && !e.shiftKey && !multiSelect) {
                e.preventDefault()
                if (other.trim()) handleSubmit()
                else setOtherError(true)
              }
            }}
            aria-label="自定义答案"
          />
        )}
      </div>
    )
  }

  return (
    <div className={`ask-user-question${hasDetail ? ' has-detail' : ''}`}>
      <div className="ask-user-header">{question.header}</div>
      <div className="ask-user-q">{question.question}</div>

      <div className="ask-user-body">
        <div
          className="ask-user-options"
          role="listbox"
          aria-multiselectable={multiSelect || undefined}
          aria-label={question.question}
        >
          {question.options.map(renderOption)}
          {renderOtherOption()}
        </div>

        {hasDetail && (
          <div className="ask-user-detail" aria-live="polite">
            {detailOption?.detail ? (
              <div className="ask-user-detail-title">{detailOption.label}</div>
            ) : null}
            {detailOption?.detail ? (
              <div className="ask-user-detail-content markdown-body">
                <MarkdownDetail content={detailOption.detail} />
              </div>
            ) : (
              <div className="ask-user-detail-empty">选择左侧选项查看详情</div>
            )}
          </div>
        )}
      </div>

      <div className="ask-user-actions">
        <button
          type="button"
          className="ask-user-btn ask-user-btn-ignore"
          onClick={handleIgnore}
        >
          <span className="ask-user-btn-icon" aria-hidden="true">
            <RotateCcw size={13} />
          </span>
          <span>{ignoreLabel}</span>
        </button>

        <button
          type="button"
          className="ask-user-btn ask-user-btn-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          <span className="ask-user-btn-icon" aria-hidden="true">
            <Check size={14} />
          </span>
          <span>{submitLabel}</span>
        </button>
      </div>
    </div>
  )
}
