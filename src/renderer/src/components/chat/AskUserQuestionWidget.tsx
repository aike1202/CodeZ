import { useState } from 'react'
import './AskUserQuestionWidget.css'
import type { AskUserRequestState } from '../../stores/chatStore'

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

function QuestionBlock({ question, onSubmit }: {
  question: AskUserRequestState['questions'][number]
  onSubmit: (answer: string | string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [other, setOther] = useState('')
  const [showOther, setShowOther] = useState(false)

  const toggle = (label: string) => {
    if (question.multiSelect) {
      setSelected((prev) => prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label])
    } else {
      setSelected([label])
    }
  }

  const submit = () => {
    if (showOther && other.trim()) { onSubmit(question.multiSelect ? [other.trim()] : other.trim()); return }
    if (selected.length === 0) return
    onSubmit(question.multiSelect ? selected : selected[0])
  }

  return (
    <div className="ask-user-question">
      <div className="ask-user-header">{question.header}</div>
      <div className="ask-user-q">{question.question}</div>
      <div className="ask-user-options">
        {question.options.map((opt) => (
          <button
            key={opt.label}
            className={`ask-user-option ${selected.includes(opt.label) ? 'selected' : ''}`}
            onClick={() => toggle(opt.label)}
          >
            <div className="ask-user-option-label">{opt.label}</div>
            {opt.description && <div className="ask-user-option-desc">{opt.description}</div>}
          </button>
        ))}
        <button className={`ask-user-option ${showOther ? 'selected' : ''}`} onClick={() => setShowOther((v) => !v)}>
          <div className="ask-user-option-label">Other…</div>
        </button>
      </div>
      {showOther && (
        <input
          className="ask-user-other-input"
          placeholder="自定义答案"
          value={other}
          onChange={(e) => setOther(e.target.value)}
        />
      )}
      <button className="ask-user-submit" onClick={submit} disabled={!showOther && selected.length === 0}>
        提交
      </button>
    </div>
  )
}
