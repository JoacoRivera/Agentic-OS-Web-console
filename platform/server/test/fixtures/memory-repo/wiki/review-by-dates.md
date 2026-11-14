---
tags: [fixture, lessons]
---

# Review-by dates (synthetic fixture)

Synthetic lessons, each to be confirmed by a further case by its date.

- A lesson confirmed later: `review-by: 2099-01-01`.
- A lesson past its date: `review-by: 2026-01-05`.
- A lesson with a malformed date: `review-by: soon`.

A bare prose mention of a `review-by:` date is not a token and is ignored.
