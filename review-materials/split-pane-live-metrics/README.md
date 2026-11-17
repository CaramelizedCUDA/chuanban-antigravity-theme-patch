# Verification Evidence: Multi-Pane Split Metrics & Dynamic Wrapping (`a5cde5a`)

This directory archives reproducible test evidence and redacted Antigravity `2.32.1` screenshots for commit [`a5cde5ae20a4eb2753924e62fb120bee81d0f9d5`](../../tree/fix/split-pane-live-metrics) on branch `fix/split-pane-live-metrics`.

## Contents

- `split-pane-metrics.test.mjs`: 8-test Node regression suite (`node:test` + `node:assert/strict`) covering:
  1. 2-pane & 3-pane independent pill mounting, WeakMap tooltips, focus switching, and unique primary `#ag-live-metrics-pill`
  2. Mixed chat + home split pane isolation (prevents home composer from inheriting chat UUID)
  3. Dynamic narrow-pane wrapping (`neededPillW = Math.ceil(textScrollW + 12)`, `+16px` hysteresis without oscillation)
  4. `!ENABLED` cleanup & hot-reload stale pill eviction / observer disposal
  5. `core/daemon.mjs` `normalizeCascadeIdList` & `parseMetricsSubscriptionPayload` (single UUID, JSON array, `[]`, `%2B` URL-encoded split, 12-item cap)
  6. Recreated pane cached metrics backfill & immediate stale-text clear on uncached navigation
  7. Same-version reinjection hover tooltip synchronization on retained pills
  8. `core/theme.css` multi-pane selectors & `core/manifest.json` 4/4 SHA-256 + byte-size parity
- `test-output.txt`: Captured TAP output from running `node --test review-materials/split-pane-live-metrics/split-pane-metrics.test.mjs` (`8/8` passing).
- `live-4pane-cdp-summary.json`: Sanitized read-only CDP DOM verification snapshot taken against live Antigravity `2.32.1` with 4 open split panes (`754px` wide panes in `middle` row mode and `377px` narrow panes automatically wrapped to `bottom` row mode, `textClientWidth === textScrollWidth`).
- `screenshots/`: Redacted screenshots (`before-v542-2pane.png`, `before-v542-3pane.png`, `after-4pane-wrapped.png`) with chat bodies, private paths, pane titles, and desktop overlays blurred while keeping split dividers, composer bars, pills, and tooltip sharp.

## Running Locally

```bash
node --test review-materials/split-pane-live-metrics/split-pane-metrics.test.mjs
```
