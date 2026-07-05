import React from 'react'
import './Button.css'

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  // Ant Design style props
  type?: 'primary' | 'default' | 'dashed' | 'text' | 'link' | 'dark'
  htmlType?: 'button' | 'submit' | 'reset'
  danger?: boolean
  size?: 'small' | 'middle' | 'large' | 'sm' | 'md' | 'lg' | 'none'
  loading?: boolean
  icon?: React.ReactNode
  
  // Legacy compatibility props
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon' | 'dark' | 'danger'
}

export default function Button({
  children,
  type,
  htmlType = 'button',
  variant,
  danger = false,
  size = 'middle',
  loading = false,
  icon,
  className = '',
  disabled,
  ...props
}: ButtonProps): React.ReactElement {
  // Resolve type from legacy variant if type is not provided
  let btnType = type
  let isDanger = danger
  if (!btnType && variant) {
    if (variant === 'primary') btnType = 'primary'
    else if (variant === 'secondary') btnType = 'default'
    else if (variant === 'ghost') btnType = 'text'
    else if (variant === 'danger') {
      btnType = 'default'
      isDanger = true
    } else if (variant === 'dark') {
      btnType = 'dark'
    } else {
      btnType = 'default'
    }
  } else if (!btnType) {
    btnType = 'default'
  }

  // Resolve size
  let btnSizeClass = 'cz-btn-size-middle'
  if (size === 'small' || size === 'sm') {
    btnSizeClass = 'cz-btn-size-small'
  } else if (size === 'large' || size === 'lg') {
    btnSizeClass = 'cz-btn-size-large'
  } else if (size === 'none') {
    btnSizeClass = 'cz-btn-size-none'
  }

  const classes = [
    'cz-btn',
    `cz-btn-${btnType}`,
    btnSizeClass,
    isDanger ? 'cz-btn-danger' : '',
    variant === 'icon' ? 'cz-btn-icon-only' : '',
    variant === 'dark' ? 'cz-btn-dark' : '',
    loading ? 'cz-btn-loading' : '',
    className
  ].filter(Boolean).join(' ')

  return (
    <button
      type={htmlType}
      disabled={disabled || loading}
      className={classes}
      {...props}
    >
      {loading ? (
        <span className="cz-btn-loading-icon">
          <svg className="cz-btn-spin" fill="none" viewBox="0 0 24 24">
            <circle className="cz-btn-spin-circle" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="cz-btn-spin-path" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </span>
      ) : icon ? (
        <span className="cz-btn-icon-wrapper">{icon}</span>
      ) : null}
      {children ? <span className="cz-btn-label">{children}</span> : null}
    </button>
  )
}
