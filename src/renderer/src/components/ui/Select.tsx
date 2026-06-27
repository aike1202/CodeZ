import React, { forwardRef } from 'react'
import './Select.css'

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  variant?: 'default'
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(({
  variant = 'default',
  className = '',
  children,
  ...props
}, ref): React.ReactElement => {
  const classes = [
    'select-field',
    `select-${variant}`,
    className
  ].filter(Boolean).join(' ')

  return (
    <div className="select-wrapper">
      <select
        ref={ref}
        className={classes}
        {...props}
      >
        {children}
      </select>
      <div className="select-arrow">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  )
})

Select.displayName = 'Select'

export default Select
