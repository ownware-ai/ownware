/**
 * Media Processing — shared utilities for image, PDF, and notebook handling.
 *
 * Used by:
 * - tools/builtins/filesystem.ts (when the MODEL calls readFile on a media file)
 * - cortex/gateway/attachments.ts (when the USER attaches/pastes a file)
 *
 * @packageDocumentation
 */

// Constants
export {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_TARGET_RAW_SIZE,
  IMAGE_MAX_WIDTH,
  IMAGE_MAX_HEIGHT,
  IMAGE_EXTENSIONS,
  PDF_TARGET_RAW_SIZE,
  API_PDF_MAX_PAGES,
  PDF_MAX_PAGES_PER_READ,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_EXTRACT_SIZE,
  API_MAX_MEDIA_PER_REQUEST,
  MAX_TEXT_READ_SIZE,
  MAX_LINES_TO_READ,
  BINARY_CHECK_SIZE,
  BINARY_EXTENSIONS,
  hasBinaryExtension,
  hasImageExtension,
  isPDFExtension,
  isNotebookExtension,
  isBinaryContent,
} from './constants.js'
export type { ImageMediaType } from './constants.js'

// Types
export type {
  ImageDimensions,
  ImageProcessResult,
  CompressedImageResult,
  PDFErrorReason,
  PDFError,
  PDFResult,
  PDFReadResult,
  PDFExtractResult,
  NotebookContent,
  NotebookCell,
  NotebookCellOutput,
  ProcessedCell,
  ProcessedOutput,
  RawAttachment,
  AttachmentCategory,
} from './types.js'

// Image processing
export {
  detectImageFormat,
  detectImageFormatFromBase64,
  processImage,
  processImageToBase64,
  createImageMetadataText,
  ImageProcessError,
} from './image.js'

// PDF processing
export {
  readPDF,
  getPDFPageCount,
  isPdftoppmAvailable,
  extractPDFPages,
  parsePDFPageRange,
} from './pdf.js'

// Notebook processing
export {
  readNotebook,
  notebookCellsToContent,
} from './notebook.js'

// Attachment processing
export {
  processAttachment,
  processAttachments,
  categorizeFile,
  validateAttachments,
  AttachmentValidationError,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_ITEM_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MAX_FILENAME_CHARS,
} from './attachments.js'
export type { AttachmentValidationCode, ValidatedAttachments } from './attachments.js'
