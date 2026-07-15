import { randomUUID } from 'crypto'
import type {
  AgentMailboxMessage,
  AgentMessageType
} from '../../../shared/types/subagent'

const MAX_MESSAGES_PER_SESSION = 500

export interface AgentMailboxPersistence {
  saveMessages(sessionId: string, messages: AgentMailboxMessage[]): Promise<void>
}

interface MailboxWaiter {
  sessionId: string
  recipient: string
  authors?: Set<string>
  resolve(messages: AgentMailboxMessage[]): void
  timer: NodeJS.Timeout
}

export class AgentMailbox {
  private readonly messages = new Map<string, AgentMailboxMessage>()
  private readonly waiters = new Set<MailboxWaiter>()
  private persistence?: AgentMailboxPersistence

  configurePersistence(persistence: AgentMailboxPersistence): void {
    this.persistence = persistence
  }

  restoreSession(sessionId: string, messages: AgentMailboxMessage[]): void {
    this.removeSessionFromMemory(sessionId)
    for (const message of messages) this.messages.set(message.id, { ...message })
  }

  async post(input: {
    sessionId: string
    type: AgentMessageType
    author: string
    recipient: string
    payload: string
    delivered?: boolean
  }): Promise<AgentMailboxMessage> {
    const message: AgentMailboxMessage = {
      id: `amsg_${randomUUID()}`,
      sessionId: input.sessionId,
      type: input.type,
      author: input.author,
      recipient: input.recipient,
      payload: input.payload,
      createdAt: Date.now(),
      readAt: input.delivered ? Date.now() : undefined
    }
    this.messages.set(message.id, message)
    this.prune(input.sessionId)
    await this.persist(input.sessionId)
    this.notifyWaiters(message)
    return { ...message }
  }

  peekUnread(sessionId: string, recipient: string, authors?: readonly string[]): AgentMailboxMessage[] {
    const allowedAuthors = authors?.length ? new Set(authors) : undefined
    return this.list(sessionId).filter((message) =>
      !message.readAt &&
      message.recipient === recipient &&
      (!allowedAuthors || allowedAuthors.has(message.author))
    )
  }

  async consume(sessionId: string, recipient: string): Promise<AgentMailboxMessage[]> {
    const unread = this.peekUnread(sessionId, recipient)
    if (unread.length === 0) return []
    const readAt = Date.now()
    for (const message of unread) {
      const current = this.messages.get(message.id)
      if (current) this.messages.set(message.id, { ...current, readAt })
    }
    await this.persist(sessionId)
    return unread.map((message) => ({ ...message, readAt }))
  }

  waitForUnread(
    sessionId: string,
    recipient: string,
    timeoutMs: number,
    authors?: readonly string[]
  ): Promise<AgentMailboxMessage[]> {
    const existing = this.peekUnread(sessionId, recipient, authors)
    if (existing.length > 0 || timeoutMs <= 0) return Promise.resolve(existing)
    return new Promise((resolve) => {
      const waiter: MailboxWaiter = {
        sessionId,
        recipient,
        authors: authors?.length ? new Set(authors) : undefined,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve([])
        }, timeoutMs)
      }
      waiter.timer.unref?.()
      this.waiters.add(waiter)
    })
  }

  list(sessionId?: string): AgentMailboxMessage[] {
    return Array.from(this.messages.values())
      .filter((message) => !sessionId || message.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((message) => ({ ...message }))
  }

  removeSession(sessionId: string): void {
    this.removeSessionFromMemory(sessionId)
    for (const waiter of this.waiters) {
      if (waiter.sessionId !== sessionId) continue
      clearTimeout(waiter.timer)
      waiter.resolve([])
      this.waiters.delete(waiter)
    }
  }

  private removeSessionFromMemory(sessionId: string): void {
    for (const [id, message] of this.messages) {
      if (message.sessionId === sessionId) this.messages.delete(id)
    }
  }

  private notifyWaiters(message: AgentMailboxMessage): void {
    for (const waiter of this.waiters) {
      if (
        waiter.sessionId !== message.sessionId ||
        waiter.recipient !== message.recipient ||
        (waiter.authors && !waiter.authors.has(message.author))
      ) continue
      clearTimeout(waiter.timer)
      this.waiters.delete(waiter)
      waiter.resolve(this.peekUnread(waiter.sessionId, waiter.recipient, waiter.authors ? [...waiter.authors] : undefined))
    }
  }

  private prune(sessionId: string): void {
    const messages = this.list(sessionId)
    if (messages.length <= MAX_MESSAGES_PER_SESSION) return
    const removable = messages.filter((message) => Boolean(message.readAt))
    for (const message of removable.slice(0, messages.length - MAX_MESSAGES_PER_SESSION)) {
      this.messages.delete(message.id)
    }
  }

  private async persist(sessionId: string): Promise<void> {
    if (!this.persistence) return
    await this.persistence.saveMessages(sessionId, this.list(sessionId))
  }
}

