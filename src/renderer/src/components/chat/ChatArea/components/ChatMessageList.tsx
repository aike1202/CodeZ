import React from 'react'
import MessageBody from '../../MessageBody'
import IconBot from '../../../icons/IconBot'
import Flex from '../../../ui/Flex'
import Stack from '../../../ui/Stack'
import { AgentMessageContent } from '../../AgentMessageContent'
import type { ChatMessage } from '../../../../stores/chatStore'

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
          <Flex key={msg.id} justify="end" className="w-full">
            <div className="user-message-bubble">
              <MessageBody content={msg.content} onFileClick={handleFileClick} />
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
    </Stack>
  )
}
