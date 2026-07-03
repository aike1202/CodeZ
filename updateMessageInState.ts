export function updateMessageInState(state: any, msgId: string, updater: (m: any) => any) {
  let updatedActive = false
  const activeId = state.activeSessionId

  const newSessions = state.sessions.map((sess: any) => {
    let found = false
    const nMsgs = sess.messages.map((m: any) => {
      if (m.id === msgId) {
        found = true
        return updater(m)
      }
      return m
    })
    
    if (found) {
      if (sess.id === activeId) {
        updatedActive = true
      }
      return { ...sess, messages: nMsgs }
    }
    return sess
  })

  return {
    sessions: newSessions,
    messages: updatedActive ? newSessions.find((s:any) => s.id === activeId)?.messages || [] : state.messages
  }
}
