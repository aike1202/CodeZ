import React from 'react'

export default function IconMore(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" {...props}>
      <circle cx="12" cy="12" r="1.5"></circle>
      <circle cx="19" cy="12" r="1.5"></circle>
      <circle cx="5" cy="12" r="1.5"></circle>
    </svg>
  )
}
