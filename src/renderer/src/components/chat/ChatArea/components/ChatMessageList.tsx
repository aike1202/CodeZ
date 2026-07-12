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
import ImageAttachmentGrid from '../../ImageAttachmentGrid'
import ImagePreviewModal from '../../ImagePreviewModal'
import type { ImageAttachment } from '@shared/types/attachment'

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

interface ChatMessageRowProps extends Omit<ChatMessageListProps, 'messages'> {
  msg: ChatMessage
  showParallelExecution: boolean
  onOpenImages: (attachments: ImageAttachment[], index: number) => void
  onPreviewRevert: (msgId: string) => void
  revertDisabled: boolean
}

const ChatMessageRow = React.memo(function ChatMessageRow({
  msg,
  lastStreamingMsgId,
  showParallelExecution,
  handleFileClick,
  handleDiffClick,
  onOpenImages,
  onPreviewRevert,
  revertDisabled
}: ChatMessageRowProps): React.ReactElement {
  if (msg.role === 'system') {
    return (
      <div
        className="chat-message-row w-full text-center my-4"
        data-chat-message-id={msg.id}
        style={{ color: 'var(--text-muted, #9ca3af)', fontSize: '0.75rem' }}
      >
        {msg.content}
      </div>
    )
  }

  const messageAttachments = msg.attachments || []
  const hasText = Boolean(msg.content.trim())
  if (msg.role === 'user') {
    return (
      <Flex
        justify="end"
        className="chat-message-row w-full group animate-message-in"
        data-chat-message-id={msg.id}
        style={{ position: 'relative' }}
      >
        <div className={`user-message-bubble${messageAttachments.length ? ' user-message-bubble--with-images' : ''}`}>
          {messageAttachments.length > 0 ? (
            <ImageAttachmentGrid
              attachments={messageAttachments}
              mode="readonly"
              onOpen={(index) => onOpenImages(messageAttachments, index)}
            />
          ) : null}
          {hasText ? <MessageBody content={msg.content} onFileClick={handleFileClick} /> : null}
        </div>
        <div className="revert-btn-container">
          <button
            disabled={revertDisabled}
            onClick={() => {
              onPreviewRevert(msg.id)
            }}
            className="revert-message-btn"
            title="撤回到此处并还原之后的所有文件修改"
          >
            <IconRestore width={14} height={14} />
          </button>
        </div>
      </Flex>
    )
  }

  return (
    <Flex
      justify="start"
      className="chat-message-row w-full max-w-3xl animate-message-in"
      data-chat-message-id={msg.id}
    >
      <Flex align="center" justify="center" className="agent-avatar">
        <IconBot width={18} height={18} />
      </Flex>
      <AgentMessageContent
        msg={msg}
        lastStreamingMsgId={lastStreamingMsgId}
        showParallelExecution={showParallelExecution}
        handleFileClick={handleFileClick}
        handleDiffClick={handleDiffClick}
      />
    </Flex>
  )
})

export function ChatMessageList({
  messages,
  lastStreamingMsgId,
  handleFileClick,
  handleDiffClick
}: ChatMessageListProps): React.ReactElement {
  const [previewData, setPreviewData] = React.useState<{ msgId: string, toDelete: string[], toRestore: string[], unknownStatus?: boolean } | null>(null)
  const [imagePreview, setImagePreview] = React.useState<{
    attachments: ImageAttachment[]
    index: number
  } | null>(null)
  const handleOpenImages = React.useCallback((attachments: ImageAttachment[], index: number) => {
    setImagePreview({ attachments, index })
  }, [])
  const handlePreviewRevert = React.useCallback(async (msgId: string) => {
    const preview = await useChatStore.getState().previewRevertMessage(msgId)
    setPreviewData(preview
      ? { msgId, ...preview }
      : { msgId, toDelete: [], toRestore: [], unknownStatus: true })
  }, [])

  const latestAgentMessageId = React.useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'agent') return messages[index].id
    }
    return null
  }, [messages])

  return (
    <Stack gap={6} className="app-message-list">
      {messages.map((msg) => {
        return (
          <ChatMessageRow
            key={msg.id}
            msg={msg}
            lastStreamingMsgId={lastStreamingMsgId}
            showParallelExecution={msg.id === latestAgentMessageId}
            handleFileClick={handleFileClick}
            handleDiffClick={handleDiffClick}
            onOpenImages={handleOpenImages}
            onPreviewRevert={handlePreviewRevert}
            revertDisabled={Boolean(lastStreamingMsgId)}
          />
        )
      })}

      {imagePreview ? (
        <ImagePreviewModal
          attachments={imagePreview.attachments}
          initialIndex={imagePreview.index}
          onClose={() => setImagePreview(null)}
        />
      ) : null}
      
      {previewData && (
        <RevertPreviewModal
          toDelete={previewData.toDelete}
          toRestore={previewData.toRestore}
          unknownStatus={previewData.unknownStatus}
          onConfirm={async () => {
            const reverted = await useChatStore.getState().revertToMessage(previewData.msgId)
            if (reverted) setPreviewData(null)
          }}
          onCancel={() => setPreviewData(null)}
        />
      )}
    </Stack>
  )
}
