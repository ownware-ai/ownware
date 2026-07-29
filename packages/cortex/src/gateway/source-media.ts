/**
 * The closed set of source media types this gateway ACCEPTS at upload.
 *
 * Membership is earned, not listed: a type appears here only when
 * `inspect()` in source-byte-store has a real verification for it —
 * text/plain is fatally UTF-8 decoded, application/pdf is checked for PDF
 * framing, and the two OOXML types are checked for ZIP container framing.
 * Accepting a type with no verifier would make `verifiedMediaType` an
 * attestation instead of an observation.
 *
 * Upload acceptance is deliberately SEPARATE from preparation capability:
 * `extract_text` still refuses every verified type other than text/plain
 * with the typed `source_media_unsupported`, and callers discover the
 * accepted set from the capabilities advertisement, never by probing.
 */
export const SOURCE_MEDIA_TYPES = [
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const

export type SourceMediaType = (typeof SOURCE_MEDIA_TYPES)[number]

/**
 * The OOXML types share one container: both are ZIP archives, and the
 * framing check (local-file-header magic + end-of-central-directory in the
 * tail) cannot tell a Word document from a spreadsheet without unzipping.
 * That is the same honesty level as the PDF check — `%PDF-` framing does
 * not prove a well-formed PDF either. `verifiedMediaType` therefore
 * records "bytes match the declared type's container framing", and a
 * docx declared as xlsx passes framing exactly as any `%PDF-…%%EOF` bytes
 * pass the PDF check. The declaration stays the uploader's claim.
 */
export const OOXML_MEDIA_TYPES: readonly SourceMediaType[] = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]

export function isSourceMediaType(value: unknown): value is SourceMediaType {
  return (SOURCE_MEDIA_TYPES as readonly unknown[]).includes(value)
}
