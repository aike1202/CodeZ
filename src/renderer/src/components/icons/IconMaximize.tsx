import React from 'react'

export function IconMaximize(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" {...props}>
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

export default IconMaximize
