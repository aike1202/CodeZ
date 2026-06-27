import React from 'react'
import './Button.css'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon' | 'dark' | 'danger'
  size?: 'sm' | 'md' | 'lg' | 'none'
  loading?: boolean
  icon?: React.ReactNode
}

export default function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className = '',
  disabled,
  ...props
}: ButtonProps): React.ReactElement {
  const classes = [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    className
  ].filter(Boolean).join(' ')

  return (
    <button
      disabled={disabled || loading}
      className={classes}
      {...props}
    >
      {loading ? (
        <svg className="animate-spin h-3.5 w-3.5 text-current shrink-0 mr-1.5" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      ) : icon ? (
        <span className="btn-icon-wrapper shrink-0">{icon}</span>
      ) : null}
      {children}
    </button>
  )
}
