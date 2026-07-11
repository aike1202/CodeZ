import React from 'react'

export function IconWindowRestore(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" {...props}>
      <path
        d="M4 1.5h5.5a1 1 0 0 1 1 1V8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="1.5"
        y="3.5"
        width="7"
        height="7"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}

export default IconWindowRestore
