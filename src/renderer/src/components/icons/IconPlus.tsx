import React from 'react'

export default function IconPlus(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <line x1="12" y1="5" x2="12" y2="19"></line>
      <line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  )
}
