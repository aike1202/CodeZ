import React from 'react'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}

export default function Switch({ checked, onChange, disabled, className = '', ariaLabel }: SwitchProps): React.ReactElement {
  return (
    <label className={`z-switch ${disabled ? 'disabled' : ''} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="z-switch-slider"></span>
    </label>
  )
}
