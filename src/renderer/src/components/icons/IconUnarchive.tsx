import React from 'react'

export default function IconUnarchive(props: React.SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <polyline points="21 8 21 21 3 21 3 8"></polyline>
    <rect x="1" y="3" width="22" height="5"></rect>
    <polyline points="10 16 12 14 14 16"></polyline>
    <line x1="12" y1="14" x2="12" y2="20"></line>
  </svg>
  )
}
