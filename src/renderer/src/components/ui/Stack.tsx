import React, { forwardRef } from 'react'
import Flex, { FlexProps } from './Flex'

export interface StackProps extends Omit<FlexProps, 'direction'> {}

const Stack = forwardRef<HTMLDivElement, StackProps>(({
  className = '',
  ...props
}, ref): React.ReactElement => {
  return (
    <Flex
      ref={ref}
      direction="col"
      className={className}
      {...props}
    />
  )
})

Stack.displayName = 'Stack'

export default Stack
