import React from 'react'

export function IconRestore(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" {...props}>
      <rect x="2.5" y="1.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 4.5 h -1 a 1 1 0 0 0 -1 1 v 5 a 1 1 0 0 0 1 1 h 5 a 1 1 0 0 0 1 -1 v -1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export default IconRestore
