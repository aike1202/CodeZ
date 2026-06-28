import React, { forwardRef } from 'react'
import './Select.css'

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  variant?: 'default'
  size?: 'small' | 'middle' | 'large'
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(({
  variant = 'default',
  size = 'middle',
  className = '',
  children,
  ...props
}, ref): React.ReactElement => {
  const classes = [
    'cz-select-field',
    `cz-select-${variant}`,
    `cz-select-size-${size}`,
    className
  ].filter(Boolean).join(' ')

  return (
    <div className="cz-select-wrapper">
      <select
        ref={ref}
        className={classes}
        {...props}
      >
        {children}
      </select>
      <div className="cz-select-arrow">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  )
})

Select.displayName = 'Select'

export default Select
