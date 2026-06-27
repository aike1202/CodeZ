import React, { forwardRef } from 'react'
import './Card.css'

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'panel' | 'flat'
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'xl'
}

const Card = forwardRef<HTMLDivElement, CardProps>(({
  variant = 'default',
  rounded = 'md',
  className = '',
  children,
  ...props
}, ref): React.ReactElement => {
  const classes = [
    'card',
    `card-${variant}`,
    `card-round-${rounded}`,
    className
  ].filter(Boolean).join(' ')

  return (
    <div
      ref={ref}
      className={classes}
      {...props}
    >
      {children}
    </div>
  )
})

Card.displayName = 'Card'

export default Card
