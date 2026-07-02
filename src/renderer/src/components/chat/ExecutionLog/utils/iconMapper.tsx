import React from 'react'
import { FileIcon, FolderIcon } from '@react-symbols/icons/utils'

export function getFileExtension(fileName?: string): string {
  if (!fileName) return ''
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

export function getFileIconComponent(fileName?: string): React.ReactElement {
  if (!fileName) return React.createElement(FileIcon, { fileName: '', width: 14, height: 14 })
  const isDir = !fileName.includes('.')
  if (isDir) return React.createElement(FolderIcon, { folderName: fileName, width: 14, height: 14 })
  return React.createElement(FileIcon, { fileName, width: 14, height: 14 })
}
