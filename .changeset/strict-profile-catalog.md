---
"@ownware/client": patch
---

Reject malformed successful profile-catalog responses instead of normalizing
them to an empty catalog, including malformed public fields and ambiguous
duplicate identities.
