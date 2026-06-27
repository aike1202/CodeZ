import React from 'react'

export default function IconSend(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" {...props}>
      <line x1="12" y1="19" x2="12" y2="5"></line>
      <polyline points="5 12 12 5 19 12"></polyline>
    </svg>
  )
}
