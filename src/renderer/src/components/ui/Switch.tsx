import React from 'react'
import './Switch.css'

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export default function Switch({ checked, onChange, disabled, className = '' }: SwitchProps): React.ReactElement {
  return (
    <label className={`z-switch ${disabled ? 'disabled' : ''} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="z-switch-slider"></span>
    </label>
  )
}
