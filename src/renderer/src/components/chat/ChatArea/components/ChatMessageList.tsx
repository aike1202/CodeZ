import React from 'react'
import MessageBody from '../../MessageBody'
import IconBot from '../../../icons/IconBot'
import Flex from '../../../ui/Flex'
import Stack from '../../../ui/Stack'
import { AgentMessageContent } from '../../AgentMessageContent'
import type { ChatMessage } from '../../../../stores/chatStore'
import { useChatStore } from '../../../../stores/chatStore'
import IconRestore from '../../../icons/IconRestore'
import RevertPreviewModal from '../../../modals/RevertPreviewModal'

interface ChatMessageListProps {
  messages: ChatMessage[]
  lastStreamingMsgId: string | null
  handleFileClick: (filePath: string, virtualContent?: string) => Promise<void>
  handleDiffClick: (
    filePath: string,
    editInfo: {
      type: 'write' | 'replace'
      targetContent?: string
      replacementContent?: string
      codeContent?: string
    }
  ) => void
}

export function ChatMessageList({
  messages,
  lastStreamingMsgId,
  handleFileClick,
  handleDiffClick
}: ChatMessageListProps): React.ReactElement {
  const [previewData, setPreviewData] = React.useState<{ msgId: string, toDelete: string[], toRestore: string[] } | null>(null)

  return (
    <Stack gap={6} className="app-message-list">
      {messages.map((msg) => {
        if (msg.role === 'system') {
          return (
            <div
              key={msg.id}
              className="w-full text-center my-4"
              style={{ color: 'var(--text-muted, #9ca3af)', fontSize: '0.75rem' }}
            >
              {msg.content}
            </div>
          )
        }
        return msg.role === 'user' ? (
          <Flex key={msg.id} justify="end" className="w-full group" style={{ position: 'relative' }}>
            <div className="user-message-bubble">
              <MessageBody content={msg.content} onFileClick={handleFileClick} />
            </div>
            <div 
              className="opacity-0 group-hover:opacity-100 transition-opacity absolute" 
              style={{ bottom: '-20px', right: '4px', zIndex: 10 }}
            >
              <button 
                onClick={async () => {
                  const preview = await useChatStore.getState().previewRevertMessage(msg.id)
                  if (!preview) {
                    if (window.confirm('确定要回退到此消息吗？这将删除在此之后的所有对话，并强行撤销在此之后 AI 对工作区所做的所有文件修改。')) {
                      useChatStore.getState().revertToMessage(msg.id)
                    }
                    return
                  }
                  if (preview.toDelete.length === 0 && preview.toRestore.length === 0) {
                    if (window.confirm('确定要回退到此消息吗？（没有检测到受影响的文件修改，仅截断对话历史）')) {
                      useChatStore.getState().revertToMessage(msg.id)
                    }
                  } else {
                    setPreviewData({ msgId: msg.id, ...preview })
                  }
                }}
                style={{ 
                  background: 'var(--surface-2, #2a2a2a)', 
                  border: '1px solid var(--border-color, #3a3a3a)', 
                  borderRadius: '6px',
                  padding: '4px 8px',
                  cursor: 'pointer', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  color: 'var(--text-muted, #9ca3af)',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                }}
                title="撤回到此处并还原之后的所有文件修改"
              >
                <IconRestore width={14} height={14} />
              </button>
            </div>
          </Flex>
        ) : (
          <Flex key={msg.id} justify="start" className="w-full max-w-3xl">
            <Flex align="center" justify="center" className="agent-avatar">
              <IconBot width={18} height={18} />
            </Flex>
            <AgentMessageContent
              msg={msg}
              lastStreamingMsgId={lastStreamingMsgId}
              handleFileClick={handleFileClick}
              handleDiffClick={handleDiffClick}
            />
          </Flex>
        )
      })}
      
      {previewData && (
        <RevertPreviewModal
          toDelete={previewData.toDelete}
          toRestore={previewData.toRestore}
          onConfirm={() => {
            useChatStore.getState().revertToMessage(previewData.msgId)
            setPreviewData(null)
          }}
          onCancel={() => setPreviewData(null)}
        />
      )}
    </Stack>
  )
}
