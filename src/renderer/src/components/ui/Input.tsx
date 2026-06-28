import React, { forwardRef } from 'react'
import './Input.css'

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: 'default' | 'borderless'
  size?: 'small' | 'middle' | 'large'
  error?: string
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  variant = 'default',
  size = 'middle',
  error,
  className = '',
  disabled,
  ...props
}, ref): React.ReactElement => {
  const classes = [
    'cz-input',
    `cz-input-${variant}`,
    `cz-input-size-${size}`,
    error ? 'cz-input-error' : '',
    className
  ].filter(Boolean).join(' ')

  return (
    <input
      ref={ref}
      disabled={disabled}
      className={classes}
      {...props}
    />
  )
})

Input.displayName = 'Input'

export default Input
