/**
 * Media Processing Constants
 *
 * API limits for images, PDFs, and media.
 * These mirror Anthropic API constraints but apply across all providers.
 *
 * Zero dependencies. Import-safe from anywhere.
 */

// =============================================================================
// IMAGE LIMITS
// =============================================================================

/** Maximum base64-encoded image size (API enforced). 5 MB. */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024

/**
 * Target raw image size to stay under base64 limit after encoding.
 * Base64 increases size by 4/3: raw * 4/3 = base64 -> raw = base64 * 3/4
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4

/** Client-side max width for image resizing. */
export const IMAGE_MAX_WIDTH = 2000

/** Client-side max height for image resizing. */
export const IMAGE_MAX_HEIGHT = 2000

/** Supported image extensions that should be processed as images. */
export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
])

/** Image MIME types we accept. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// =============================================================================
// PDF LIMITS
// =============================================================================

/** Maximum raw PDF file size (20 MB -> ~27 MB base64, fits in 32 MB request). */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024

/** Maximum pages the API accepts in a single document block. */
export const API_PDF_MAX_PAGES = 100

/** Max pages per single read/extraction call. */
export const PDF_MAX_PAGES_PER_READ = 20

/** Size threshold above which PDFs are extracted into page images. */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024

/** Maximum PDF file size for the page extraction path. */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024

// =============================================================================
// MEDIA LIMITS
// =============================================================================

/** Maximum media items (images + PDFs) per API request. */
export const API_MAX_MEDIA_PER_REQUEST = 100

// =============================================================================
// TEXT FILE LIMITS
// =============================================================================

/** Maximum file size for text reading (10 MB). */
export const MAX_TEXT_READ_SIZE = 10 * 1024 * 1024

/** Default max lines to read. */
export const MAX_LINES_TO_READ = 2000

/** Bytes to check for binary content detection. */
export const BINARY_CHECK_SIZE = 8192

// =============================================================================
// BINARY EXTENSIONS
// =============================================================================

/** Extensions that are binary and should not be read as text. */
export const BINARY_EXTENSIONS = new Set([
  // Images (handled separately as media)
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif', '.svg',
  // Videos
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.z', '.tgz', '.iso',
  // Executables
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.lib', '.app', '.msi', '.deb', '.rpm',
  // Documents (PDF handled separately as media)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Bytecode
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear', '.node', '.wasm', '.rlib',
  // Database
  '.sqlite', '.sqlite3', '.db', '.mdb', '.idx',
  // Design / 3D
  '.psd', '.ai', '.eps', '.sketch', '.fig', '.xd', '.blend', '.3ds', '.max',
  // Misc
  '.swf', '.fla', '.lockb', '.dat', '.data',
])

/**
 * Check if a file path has a binary extension.
 */
export function hasBinaryExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf('.')
  if (dotIdx === -1) return false
  return BINARY_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase())
}

/**
 * Check if a file path has an image extension.
 */
export function hasImageExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf('.')
  if (dotIdx === -1) return false
  return IMAGE_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase())
}

/**
 * Check if a file path is a PDF.
 */
export function isPDFExtension(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf')
}

/**
 * Check if a file path is a Jupyter notebook.
 */
export function isNotebookExtension(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.ipynb')
}

/**
 * Check if a buffer contains binary content by looking for null bytes
 * or a high proportion of non-printable characters.
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)
  let nonPrintable = 0

  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable++
    }
  }

  return nonPrintable / checkSize > 0.1
}
