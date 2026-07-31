# React dashboard uses Vitest, jsdom, and Testing Library

Status: accepted — 2026-07-30

## Context

The original P1 seam strategy automated the exported Express app and real-process boot,
while keeping dashboard validation manual. That was an explicit ship-stage choice, not a
permanent prohibition. The dashboard now contains behavior whose correctness is not just
visual: lineage wording, generated heading IDs, local and cross-document anchor timing,
and stateful explorer interactions.

## Decision

- The `dashboard` workspace owns Vitest, jsdom, Testing Library React, user-event, and
  jest-dom as explicit dev dependencies. The harness does not depend on workspace-root
  hoisting for declaration.
- `vitest.config.js` selects jsdom, loads one accessible setup file, and clears/restores
  mocks. The setup performs explicit React cleanup and supplies only the browser method
  jsdom omits that these tests need: `Element.scrollIntoView`.
- Tests cross the same public seams as users: rendered accessible DOM, user events, and
  the browser `fetch` seam. They assert behavior and stable semantic attributes, not
  component internals or serialized snapshots.
- The platform `npm test` command runs the existing server suite first and the dashboard
  suite second. A dashboard failure cannot hide or replace server coverage.
- Real-browser validation remains a separate layer. jsdom does not implement layout or
  painting and therefore cannot prove CSS geometry, responsive layout, SVG clipping/halo
  appearance, or a real browser EventSource/SSE stream.

## Initial behavioral coverage

- `GrowthChart`: complete/incomplete lineage copy, known-source wording when coverage is
  incomplete, the full 30-point knowledge series and its final marker, accessible chart
  semantics, and `overflow="visible"` for the halo.
- Documentation: unique deterministic slugs for `Foo`, `Foo`, `Foo-1`; IDs stamped on
  rendered headings; TOC and local-anchor scrolling; and cross-document fragment scrolling
  only after the target document has loaded and rendered.
- `DocsExplorer`: a user expands a nested folder, selects a document, and the DOM exposes
  the current page.

## Consequences and baseline

The first EXEC-13 RED was the dashboard workspace's missing `test` script. Subsequent
RED→GREEN slices made incomplete lineage wording explicit, exposed the chart as an
accessible image, supplied jsdom's missing scroll primitive, and exposed tree expansion
and selection through ARIA. On 2026-07-30 the integrated result was 120/120 server tests
followed by 7/7 dashboard tests (5 test files).

The existing human Odysseus visual-fidelity pass remains required when presentation or
browser-runtime behavior changes; a green jsdom suite must never be reported as replacing
that pass.
