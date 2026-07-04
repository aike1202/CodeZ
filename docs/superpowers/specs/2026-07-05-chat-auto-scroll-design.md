# ChatArea Auto-Scroll Optimization Design

## Goal
Improve the user experience during AI response generation (streaming) in the ChatArea. Currently, the frequent DOM updates coupled with aggressive programmatic scroll-to-bottom logic prevents users from scrolling up using the mouse wheel or trackpad, creating a "fighting" sensation. The constant React re-renders tied to forced scrolling also causes UI stuttering and freezing.

## Proposed Changes

### 1. Remove Legacy "Programmatic Scroll" Timers
The existing mechanism relies on an 80ms `programmaticScrollUntil` timer to guess if a scroll event was triggered by the user or the program.
- **Change:** Completely remove `programmaticScrollUntil` and `lastScrollTop` refs. We will no longer try to differentiate scroll events based on time windows.

### 2. Explicit User Intent Interception
We will directly listen to physical input events on the scroll container to determine when the user wants to scroll manually.
- **Change:** Add `onWheel` and `onTouchStart` event listeners to the message list wrapper.
- **Behavior:** Whenever these events are fired, we immediately set `isFollowing = false`. This guarantees that actual physical interactions reliably interrupt the auto-scroll lock.

### 3. Smooth Height Tracking via ResizeObserver
Instead of forcing a scroll on every `messages` state change (which happens at high frequency during streaming), we will observe the actual DOM layout changes.
- **Change:** Implement a `ResizeObserver` on the inner container that holds all chat messages.
- **Behavior:** When the `ResizeObserver` detects an increase in height AND `isFollowing` is true, it uses `requestAnimationFrame` to update the `scrollTop` to `scrollHeight`. This decouples the scroll logic from the React render cycle, significantly improving performance and reducing layout thrashing.

### 4. Resuming Follow State
The ability to snap back to auto-following remains essential.
- **Change:** Keep the `onScroll` event listener, but restrict its responsibility to checking if the user has reached the bottom.
- **Behavior:** If `isNearBottom(container)` returns true (e.g., the user scrolled down, or dragged the scrollbar to the bottom), we automatically set `isFollowing = true`.

## Testing & Verification
1. **Scrolling against the stream:** Generate a long response from the AI. While the AI is typing, scroll up using the mouse wheel. The auto-scroll MUST stop immediately, and the view should stay exactly where the user scrolled it.
2. **Resuming the stream:** After scrolling up, scroll back down to the very bottom. The auto-scroll MUST resume seamlessly as new text arrives.
3. **Performance:** The UI should not freeze or stutter during high-speed AI output.

## TBD / Open Questions
None. The architecture explicitly targets the identified racing conditions with clear web API boundaries.
