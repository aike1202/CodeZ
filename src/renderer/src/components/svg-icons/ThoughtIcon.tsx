import React from 'react';

export const ThoughtIcon = ({ running }: { running?: boolean }) => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-amber-500 dark:text-amber-600 shrink-0 ${running ? 'animate-pulse' : ''}`}>
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .5 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
    <path d="M9 18h6" />
    <path d="M10 22h4" />
  </svg>
)
