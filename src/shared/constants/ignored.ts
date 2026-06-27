export const DEFAULT_IGNORED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'out',
  '__pycache__',
  '.idea',
  '.vscode',
  '.cache',
  '.turbo',
  'target',
  '.nuxt',
  '.output'
]

export const DEFAULT_IGNORED_EXTENSIONS = [
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.obj',
  '.o',
  '.class',
  '.pyc',
  '.pyd',
  '.lock'
]

export const DEFAULT_IGNORED_PREFIXES = ['.', '~']

export const BINARY_EXTENSIONS = [
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg',
  '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv',
  '.zip', '.tar', '.gz', '.7z', '.rar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.ttf', '.otf', '.woff', '.woff2',
  '.wasm', '.node'
]

export const MAX_FILE_READ_BYTES = 1024 * 1024       // 1 MB
export const MAX_FILE_READ_LINES = 1000
export const MAX_FILE_REJECT_BYTES = 5 * 1024 * 1024  // 5 MB
