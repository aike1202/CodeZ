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
  const [previewData, setPreviewData] = React.useState<{ msgId: string, toDelete: string[], toRestore: string[], unknownStatus?: boolean } | null>(null)

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
          <Flex key={msg.id} justify="end" className="w-full group animate-message-in" style={{ position: 'relative' }}>
            <div className="user-message-bubble">
              <MessageBody content={msg.content} onFileClick={handleFileClick} />
            </div>
            <div className="revert-btn-container">
              <button 
                onClick={async () => {
                  const preview = await useChatStore.getState().previewRevertMessage(msg.id)
                  if (!preview) {
                    setPreviewData({ msgId: msg.id, toDelete: [], toRestore: [], unknownStatus: true })
                  } else {
                    setPreviewData({ msgId: msg.id, ...preview })
                  }
                }}
                className="revert-message-btn"
                title="撤回到此处并还原之后的所有文件修改"
              >
                <IconRestore width={14} height={14} />
              </button>
            </div>
          </Flex>
        ) : (
          <Flex key={msg.id} justify="start" className="w-full max-w-3xl animate-message-in">
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
          unknownStatus={previewData.unknownStatus}
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
