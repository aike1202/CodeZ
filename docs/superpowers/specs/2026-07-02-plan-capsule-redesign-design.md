# Plan Capsule Redesign Design

## Purpose
The current `PlanCapsule` component has several UX/UI flaws:
1. It is positioned in the global `TopBar`, creating visual clutter and breaking logical containment since Plans belong to the chat session context.
2. Its visual styling is rough, lacking premium aesthetics (doesn't look like a "capsule").
3. It displays the overall Plan title rather than the actionable/currently executing step, making it less useful for real-time progress tracking.

This redesign moves the Plan Capsule into the Chat context, gives it a premium "Glassmorphism" pill shape, and focuses its content on the currently executing step.

## Architecture & Placement
- **Remove from TopBar**: `PlanCapsule` will be deleted from `src/renderer/src/components/TopBar.tsx`.
- **Add to ChatAreaLayout**: `PlanCapsule` will be rendered as an absolutely positioned overlay at the **top right** of the `ChatArea` container.
- **Z-Index**: Ensure it floats securely above chat messages but beneath modals.

## Components & Visuals

### The Capsule (Pill)
- **Shape**: Pure pill shape (`border-radius: 9999px`).
- **Texture**: Glassmorphism (`backdrop-filter: blur(12px)`) with semi-transparent background to blend beautifully in both Light and Dark themes.
- **Border/Animation**: A very subtle border that features an elegant, slow "breathing glow" effect when the Agent is actively executing a step.
- **Content**:
  - Left: An animated Lucide icon (e.g., `Loader2` spinning or `Sparkles`) representing "in progress".
  - Middle text: The title of the *currently executing step* (e.g., `P1: 登录界面设计`). If all are complete, display "Plan Completed".
  - Right: A Chevron icon (`ChevronDown` or `ChevronUp`) indicating the component is expandable.

### The Expanded Popover
- **Animation**: Smoothly drops down from the capsule with fade-in and slight slide-down (`transform/opacity` transition).
- **Header**: Shows the overarching Plan Title and global progress (e.g., `2/5`).
- **Body**: A vertical list of steps.
- **Icons**: Replace emojis with Lucide React icons (`CheckCircle2` for completed, `Loader2` for in-progress, `CircleDashed` for pending).
- **Styling**: Consistent with the application's premium CSS variables, using muted text for completed tasks (with strikethrough).

## Data Flow
- Component subscribes to `useChatStore`.
- We derive `currentStep` dynamically:
  ```typescript
  const currentStep = steps.find(s => s.status === 'in_progress') || steps.find(s => s.status === 'pending') || steps[steps.length - 1];
  ```
- If the capsule is not expanded, only `currentStep` is rendered to save space and minimize visual noise.

## Error Handling & Edge Cases
- If no `activePlan` exists, or status is not `executing`, the capsule remains hidden.
- If `subAgentStatus === 'running'` but no plan is active, show an "Exploring..." pill.
- Handle very long step titles gracefully via `text-overflow: ellipsis` and `max-width`.
