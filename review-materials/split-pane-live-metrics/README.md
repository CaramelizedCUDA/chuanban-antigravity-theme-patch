# Verification Evidence: Multi-Pane Split Metrics, Dynamic Wrapping & Side-Question (`/btw`) (`dc266bb`)

This directory archives reproducible test evidence and redacted Antigravity `2.32.1` screenshots for branch [`fix/split-pane-live-metrics`](../../tree/fix/split-pane-live-metrics) (`a5cde5ae20a4eb2753924e62fb120bee81d0f9d5` + `/btw` follow-up `dc266bb28bce3675875d7baa560c1f1a8e3ec680`).

## Contents

- `split-pane-metrics.test.mjs`: 10-test Node regression suite (`node:test` + `node:assert/strict`) covering:
  1. 2-pane & 3-pane independent pill mounting, WeakMap tooltips, focus switching, and unique primary `#ag-live-metrics-pill`
  2. Mixed chat + home split pane isolation (prevents home composer from inheriting chat UUID)
  3. Dynamic narrow-pane wrapping (`neededPillW = Math.ceil(textScrollW + 12)`, `+16px` hysteresis without oscillation)
  4. `!ENABLED` cleanup & hot-reload stale pill eviction / observer disposal
  5. `core/daemon.mjs` `normalizeCascadeIdList` & `parseMetricsSubscriptionPayload` (single UUID, JSON array, `[]`, `%2B` URL-encoded split, 12-item cap)
  6. Recreated pane cached metrics backfill & immediate stale-text clear on uncached navigation
  7. Same-version reinjection hover tooltip synchronization on retained pills
  8. Side-question (`/btw`) sibling DOM (`side-question-tab-content` / `side-question-tab-conversation`) & `[data-active-tab-id^="side_question__"]` strip fallback, blank unsent `/btw` isolation (`totalBoxes === 1`), and `[data-tab-id]` click route re-check
  9. `core/daemon.mjs` fallback `Runtime.evaluate` & `core/runtime.js` `extractAllPathnameCascadeIds()` `?tab=side_question__<uuid>` extraction (both DOM + empty-DOM early-boot fallback)
  10. `core/theme.css` multi-pane selectors & `core/manifest.json` 4/4 SHA-256 + byte-size parity
- `test-output.txt`: Captured TAP output from running `node --test review-materials/split-pane-live-metrics/split-pane-metrics.test.mjs` (`10/10` passing).
- `live-4pane-cdp-summary.json`: Sanitized read-only CDP DOM verification snapshot taken against live Antigravity `2.32.1` with 4 open split panes (`754px` wide panes in `middle` row mode and `377px` narrow panes automatically wrapped to `bottom` row mode, `textClientWidth === textScrollWidth`).
- `screenshots/`: Redacted screenshots (`before-v542-2pane.png`, `before-v542-3pane.png`, `after-4pane-wrapped.png`) with chat bodies, private paths, pane titles, and desktop overlays blurred while keeping split dividers, composer bars, pills, and tooltip sharp.

## Running Locally

```bash
node --test review-materials/split-pane-live-metrics/split-pane-metrics.test.mjs
```
