import React, { forwardRef } from 'react'
import './Input.css'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  variant?: 'default' | 'borderless'
  error?: string
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  variant = 'default',
  error,
  className = '',
  disabled,
  ...props
}, ref): React.ReactElement => {
  const classes = [
    'input-field',
    `input-${variant}`,
    error ? 'input-error' : '',
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
