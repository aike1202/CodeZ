# Chat Auto-Scroll Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement explicit user-intent interruption for chat auto-scroll and optimize performance via ResizeObserver.

**Architecture:** We will replace the timer-based heuristic with explicit DOM event listeners (`onWheel`, `onTouchStart`) to break the auto-scroll lock. We will also introduce a `ResizeObserver` on the inner message list to trigger scrolling only when content height changes, decoupling it from rapid React re-renders.

**Tech Stack:** React, DOM Events, ResizeObserver

## Global Constraints

- No project-wide constraints specified. Normal TypeScript and React rules apply.

---

### Task 1: Update ChatAreaLayout interface

**Files:**
- Modify: `src/renderer/src/components/chat/ChatAreaLayout.tsx`

**Interfaces:**
- Consumes: N/A
- Produces: `ChatAreaLayout` will accept `onWheel` and `onTouchStart` props.

- [ ] **Step 1: Add props to ChatAreaLayoutProps**

Modify `src/renderer/src/components/chat/ChatAreaLayout.tsx` to include the new event handlers:

```tsx
export interface ChatAreaLayoutProps {
  messageArea: ReactNode;
  auditArea?: ReactNode;
  promptArea: ReactNode;
  terminalPanel?: ReactNode;
  panelOpen?: boolean;
  containerRef?: React.RefObject<HTMLDivElement>;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  onWheel?: (e: React.WheelEvent<HTMLDivElement>) => void;
  onTouchStart?: (e: React.TouchEvent<HTMLDivElement>) => void;
}
```

- [ ] **Step 2: Pass props to Stack component**

In the same file, pass these props to the `Stack` component:

```tsx
      <Stack
        className={`app-chat-column ${panelOpen ? 'app-chat-column--border' : ''}`}
        ref={containerRef}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
      >
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/chat/ChatAreaLayout.tsx
git commit -m "feat: add onWheel and onTouchStart props to ChatAreaLayout"
```

---

### Task 2: Implement Interruption and ResizeObserver in ChatArea

**Files:**
- Modify: `src/renderer/src/components/chat/ChatArea/index.tsx`

**Interfaces:**
- Consumes: `ChatAreaLayout` with new props.
- Produces: A modernized, performant `ChatArea` component.

- [ ] **Step 1: Clean up old scroll state refs**

In `src/renderer/src/components/chat/ChatArea/index.tsx`, remove `programmaticScrollUntil` and `lastScrollTop` refs. 
Add `contentRef`.

```tsx
// Remove these lines:
// const programmaticScrollUntil = useRef(0)
// const lastScrollTop = useRef<number | null>(null)

// Add contentRef:
  const contentRef = useRef<HTMLDivElement>(null)
```

Remove the `lastScrollTop` assignment in the `useEffect`:

```tsx
  useEffect(() => {
    if (containerRef.current) {
      setContainerMounted(true)
    }
  }, [])
```

- [ ] **Step 2: Simplify scrollToBottom**

Remove the programmatic scroll timer from `scrollToBottom`:

```tsx
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })
  }, [])
```

- [ ] **Step 3: Simplify handleScroll**

Update `handleScroll` to only restore following when near bottom. Remove upward scroll tracking here since it's handled by `onWheel`/`onTouchStart`.

```tsx
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (isNearBottom(container)) {
      setIsFollowing(true)
    }
  }, [])
```

- [ ] **Step 4: Implement Event Handlers for Interruption**

Add these callbacks before the `return` statement:

```tsx
  const handleWheel = useCallback(() => {
    setIsFollowing(false)
  }, [])

  const handleTouchStart = useCallback(() => {
    setIsFollowing(false)
  }, [])
```

- [ ] **Step 5: Replace old useEffect with ResizeObserver**

Replace the old `useEffect` that listens to `messages` with a new one that sets up a `ResizeObserver` on `contentRef`. 

```tsx
  // Listen for activeSessionId change to force scroll
  useEffect(() => {
    if (messages.length === 0) return
    const lastMsg = messages[messages.length - 1]
    const isUserLast = lastMsg?.role === 'user'
    const isSessionChanged = prevSessionIdRef.current !== activeSessionId
    prevSessionIdRef.current = activeSessionId

    if (isUserLast || isSessionChanged) {
      setIsFollowing(true)
      scrollToBottom()
    }
  }, [messages, activeSessionId, scrollToBottom])

  // Observe content height changes
  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      if (isFollowing) {
        scrollToBottom()
      }
    })
    
    observer.observe(content)
    return () => observer.disconnect()
  }, [isFollowing, scrollToBottom])
```

- [ ] **Step 6: Update render payload**

Update the `messageArea` prop to wrap `ChatMessageList` in `contentRef`, and pass the new `onWheel` and `onTouchStart` handlers to `ChatAreaLayout`.

```tsx
      <ChatAreaLayout
        containerRef={containerRef}
        panelOpen={panelOpen}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        messageArea={
          hasMessages ? (
            <div ref={contentRef} style={{ width: '100%', flexShrink: 0 }}>
              <ChatMessageList
                messages={messages}
                lastStreamingMsgId={lastStreamingMsgId}
                handleFileClick={handleFileClick}
                handleDiffClick={handleDiffClick}
              />
            </div>
          ) : (
            <HomePage onOpenRecentProject={handleOpenRecentProject} />
          )
        }
```

- [ ] **Step 7: Verify (Manual testing)**

Run the app. Trigger AI generation. Scroll up via mouse wheel. Ensure auto-scroll stops immediately and screen doesn't jitter. Scroll back to bottom to see auto-scroll resume.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/chat/ChatArea/index.tsx
git commit -m "refactor: use ResizeObserver and explicit events for auto-scroll"
```
