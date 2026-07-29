---
"@ownware/cortex": minor
"@ownware/client": minor
---

Accept DOCX and XLSX source uploads after verifying their ZIP-container
framing, publish the expanded upload envelope as Ownware Gateway capability
version 12 / contract revision 0.31.0, and expose the same closed media-type
union through the client and OpenAPI contract.

Upload acceptance remains narrower than document understanding: preparation
continues to refuse these formats with `source_media_unsupported` until a
bounded extractor is implemented.
