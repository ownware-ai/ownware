# Notice — third-party attribution

This file records every third-party source whose work is adapted or redistributed inside this repository. It satisfies the Apache-2.0 §4(b) "prominent notice of changes" obligation for imported entries, and the equivalent attribution clauses of other permissive licenses (MIT, BSD, ISC).

Per-entry attribution is also recorded in each design-system folder's `manifest.json` under `source.upstream` + `source.license`. This file is the human-readable index that points at those structured fields.

---

## How to read this file

- **Section per upstream.** One section per upstream open-source project. The section lists the upstream URL, the license under which we received it, and every catalog entry derived from it.
- **`Status: modified`** means we changed the upstream's files (categorisation, prose, token values, folder layout). Per Apache-2.0 §4(b), this is the prominent notice that modifications were made.
- **`Status: unmodified`** means we redistribute the upstream's files byte-for-byte, only relocated into our folder layout. No prominent-notice obligation triggers, but we still credit the source.

If you contribute a new entry derived from an upstream that isn't yet listed below, add a new section here in the same shape as part of the same PR. The Cortex manifest validator does not enforce `NOTICE.md` coverage today, but the review checklist does.

---

## Upstream index

*(No imported entries in the v0.2 starter bench. The six starter entries are all `source.type: "starter"`, authored from scratch by Ownware. This section populates as brand-inspired and community entries land — anticipated in v0.2b and v0.2c.)*

### Template for future entries

```
### {Upstream project name} ({SPDX license identifier})

Upstream:   {URL of upstream repository or canonical project page}
License:    {Full license name, e.g. "Apache License 2.0"}
Status:     {modified | unmodified}

Entries derived:
- {id-1}
- {id-2}
- {id-3}

Modifications (only when Status: modified):
- {one-line description of what changed — categorisation, summary rewriting,
  token re-tuning, file restructuring, etc.}
```

---

## Repository-wide license

Unless an individual file declares otherwise, content in this repository is published under the license recorded in the repository's top-level `LICENSE` file. Imported third-party content retains its upstream license as documented per-section above; the repository-wide license does not override any third-party license terms.
