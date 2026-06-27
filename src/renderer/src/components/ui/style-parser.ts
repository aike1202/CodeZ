import React from 'react'

export interface BaseStyleProps {
  width?: 'full' | 'half' | 'screen' | string | number
  height?: 'full' | 'screen' | string | number
  minWidth?: string | number
  maxWidth?: string | number
  minHeight?: 'full' | 'screen' | string | number
  maxHeight?: string | number
  
  // Padding
  p?: number | string
  px?: number | string
  py?: number | string
  pt?: number | string
  pb?: number | string
  pl?: number | string
  pr?: number | string
  
  // Margin
  m?: number | string
  mx?: number | string
  my?: number | string
  mt?: number | string
  mb?: number | string
  ml?: number | string
  mr?: number | string

  // Colors
  bg?: 'app' | 'panel' | 'sidebar' | 'active' | 'hover' | 'white' | string
  color?: 'main' | 'muted' | 'light' | string
  
  // Typography
  font?: 'sans' | 'mono' | string
  fontSize?: string | number
  fontWeight?: string | number
  
  // Borders
  border?: 'none' | 'all' | 't' | 'b' | 'l' | 'r' | boolean
  borderColor?: 'border' | string
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | string | number
  
  // Shadow
  shadow?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | boolean
  
  // Flex layout settings for item self
  grow?: number | boolean
  shrink?: number | boolean
  basis?: string | number
  alignSelf?: 'auto' | 'start' | 'end' | 'center' | 'stretch'
  
  // Overflow
  overflow?: 'auto' | 'hidden' | 'visible' | 'scroll' | string
  overflowY?: 'auto' | 'hidden' | 'visible' | 'scroll'
  overflowX?: 'auto' | 'hidden' | 'visible' | 'scroll'
}

export function parseStyleProps<T extends BaseStyleProps>(props: T) {
  const {
    width, height, minWidth, maxWidth, minHeight, maxHeight,
    p, px, py, pt, pb, pl, pr,
    m, mx, my, mt, mb, ml, mr,
    bg, color,
    font, fontSize, fontWeight,
    border, borderColor, rounded,
    shadow,
    grow, shrink, basis, alignSelf,
    overflow, overflowY, overflowX,
    // @ts-ignore
    style: customStyle,
    ...rest
  } = props as any

  const style: React.CSSProperties = { ...customStyle }

  // 1. Dimensions
  if (width) style.width = width === 'full' ? '100%' : width === 'screen' ? '100vw' : typeof width === 'number' ? `${width}px` : width
  if (height) style.height = height === 'full' ? '100%' : height === 'screen' ? '100vh' : typeof height === 'number' ? `${height}px` : height
  if (minWidth) style.minWidth = typeof minWidth === 'number' ? `${minWidth}px` : minWidth
  if (maxWidth) style.maxWidth = typeof maxWidth === 'number' ? `${maxWidth}px` : maxWidth
  if (minHeight) style.minHeight = minHeight === 'full' ? '100%' : minHeight === 'screen' ? '100vh' : typeof minHeight === 'number' ? `${minHeight}px` : minHeight
  if (maxHeight) style.maxHeight = typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight

  // 2. Padding
  const spacing = (val: number | string) => typeof val === 'number' ? `${val * 4}px` : val
  if (p !== undefined) style.padding = spacing(p)
  if (px !== undefined) {
    style.paddingLeft = spacing(px)
    style.paddingRight = spacing(px)
  }
  if (py !== undefined) {
    style.paddingTop = spacing(py)
    style.paddingBottom = spacing(py)
  }
  if (pt !== undefined) style.paddingTop = spacing(pt)
  if (pb !== undefined) style.paddingBottom = spacing(pb)
  if (pl !== undefined) style.paddingLeft = spacing(pl)
  if (pr !== undefined) style.paddingRight = spacing(pr)

  // 3. Margin
  if (m !== undefined) style.margin = spacing(m)
  if (mx !== undefined) {
    style.marginLeft = spacing(mx)
    style.marginRight = spacing(mx)
  }
  if (my !== undefined) {
    style.marginTop = spacing(my)
    style.marginBottom = spacing(my)
  }
  if (mt !== undefined) style.marginTop = spacing(mt)
  if (mb !== undefined) style.marginBottom = spacing(mb)
  if (ml !== undefined) style.marginLeft = spacing(ml)
  if (mr !== undefined) style.marginRight = spacing(mr)

  // 4. Background and Colors
  if (bg) {
    if (bg === 'app') style.backgroundColor = 'var(--bg-app)'
    else if (bg === 'panel') style.backgroundColor = 'var(--bg-panel)'
    else if (bg === 'sidebar') style.backgroundColor = 'var(--bg-sidebar)'
    else if (bg === 'active') style.backgroundColor = 'var(--bg-active)'
    else if (bg === 'hover') style.backgroundColor = 'var(--bg-hover)'
    else if (bg === 'white') style.backgroundColor = '#ffffff'
    else style.backgroundColor = bg
  }
  if (color) {
    if (color === 'main') style.color = 'var(--text-main)'
    else if (color === 'muted') style.color = 'var(--text-muted)'
    else if (color === 'light') style.color = 'var(--text-light)'
    else style.color = color
  }

  // 5. Typography
  if (font) {
    if (font === 'sans') style.fontFamily = 'var(--font-sans)'
    else if (font === 'mono') style.fontFamily = 'var(--font-mono)'
    else style.fontFamily = font
  }
  if (fontSize !== undefined) style.fontSize = typeof fontSize === 'number' ? `${fontSize}px` : fontSize
  if (fontWeight !== undefined) style.fontWeight = fontWeight

  // 6. Borders and Rounded corners
  if (border !== undefined) {
    const borderValue = `1px solid ${borderColor === 'border' ? 'var(--border)' : (borderColor || 'var(--border)')}`
    if (border === true || border === 'all') style.border = borderValue
    else if (border === 't') style.borderTop = borderValue
    else if (border === 'b') style.borderBottom = borderValue
    else if (border === 'l') style.borderLeft = borderValue
    else if (border === 'r') style.borderRight = borderValue
  }
  if (rounded !== undefined) {
    if (rounded === 'none') style.borderRadius = '0px'
    else if (rounded === 'sm') style.borderRadius = '2px'
    else if (rounded === 'md') style.borderRadius = '6px'
    else if (rounded === 'lg') style.borderRadius = '8px'
    else if (rounded === 'xl') style.borderRadius = '12px'
    else if (rounded === '2xl') style.borderRadius = '16px'
    else style.borderRadius = typeof rounded === 'number' ? `${rounded}px` : rounded
  }

  // 7. Shadow
  if (shadow) {
    if (shadow === true || shadow === 'md') style.boxShadow = '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)'
    else if (shadow === 'sm') style.boxShadow = '0 1px 2px 0 rgb(0 0 0 / 0.05)'
    else if (shadow === 'lg') style.boxShadow = '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)'
    else if (shadow === 'xl') style.boxShadow = '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)'
    else if (shadow === '2xl') style.boxShadow = '0 25px 50px -12px rgb(0 0 0 / 0.25)'
    else style.boxShadow = shadow
  }

  // 8. Flex parameters
  if (grow !== undefined) style.flexGrow = grow === true ? 1 : grow === false ? 0 : grow
  if (shrink !== undefined) style.flexShrink = shrink === true ? 1 : shrink === false ? 0 : shrink
  if (basis !== undefined) style.flexBasis = basis
  if (alignSelf) style.alignSelf = alignSelf

  // 9. Overflow
  if (overflow) style.overflow = overflow
  if (overflowY) style.overflowY = overflowY
  if (overflowX) style.overflowX = overflowX

  return { style, rest }
}
