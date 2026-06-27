import React, { forwardRef } from 'react'
import './Flex.css'

export interface FlexProps extends React.HTMLAttributes<HTMLDivElement> {
  inline?: boolean
  direction?: 'row' | 'col' | 'row-reverse' | 'col-reverse'
  align?: 'start' | 'end' | 'center' | 'baseline' | 'stretch'
  justify?: 'start' | 'end' | 'center' | 'between' | 'around' | 'evenly'
  wrap?: 'wrap' | 'nowrap' | 'wrap-reverse'
  gap?: number | string
}

const Flex = forwardRef<HTMLDivElement, FlexProps>(({
  inline = false,
  direction = 'row',
  align,
  justify,
  wrap,
  gap,
  className = '',
  style,
  children,
  ...props
}, ref): React.ReactElement => {
  const classes = [
    inline ? 'inline-flex-container' : 'flex-container',
    `flex-dir-${direction}`,
    align ? `flex-align-${align}` : '',
    justify ? `flex-justify-${justify}` : '',
    wrap ? `flex-wrap-${wrap}` : '',
    className
  ].filter(Boolean).join(' ')

  const inlineStyle: React.CSSProperties = {
    ...style,
    gap: typeof gap === 'number' ? `${gap * 4}px` : gap
  }

  return (
    <div
      ref={ref}
      className={classes}
      style={inlineStyle}
      {...props}
    >
      {children}
    </div>
  )
})

Flex.displayName = 'Flex'

export default Flex
