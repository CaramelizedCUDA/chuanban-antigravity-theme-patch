# Evidence Bundle: Antigravity Host Fingerprint Gate (`fix/localhost-guest-host-gate`)

This branch stores the standalone verification harness, anonymized machine assertions, and sanitized Before -> After screenshots for [`fix/localhost-guest-host-gate`](https://github.com/CaramelizedCUDA/chuanban-antigravity-theme-patch/tree/fix/localhost-guest-host-gate) (based on upstream [`v5.3.0@6a263b5`](https://github.com/Anarcadia/chuanban-antigravity-theme-patch/commit/6a263b50cb575b22059f4429a9ba9625c0c540df)), keeping the fix branch limited to the 6 core/CLI/doc files.

## Directory Layout

- [`mock-cdp-host-gate.mjs`](mock-cdp-host-gate.mjs) — Zero-dependency Node `>= 22` Mock CDP + `node:vm` E2E regression suite (11 cases). Uses built-in `node:http`, `node:crypto` (RFC 6455 WS server), `node:vm`, and isolated temp sandboxes without touching any live Antigravity `DevToolsActivePort` or user installation directory.
- [`red-v5.3.0-baseline.txt`](red-v5.3.0-baseline.txt) — Output against unpatched `v5.3.0@6a263b5` (`3/11 PASS, 8 FAIL`).
- [`green-b-plus.txt`](green-b-plus.txt) — Output against patched `fix/localhost-guest-host-gate` (`11/11 PASS, 0 FAIL`).
- [`live-non-regression-summary.json`](live-non-regression-summary.json) — Sanitized Windows 11 (`Node v22.22.2`, Antigravity stable channel) 6-item live non-regression summary captured while `http://127.0.0.1:4173/` remained open in the built-in browser.
- [`screenshots/`](screenshots/) — 8 sanitized viewport-only Before -> After PNG screenshots.

## How to Run the Mock CDP Regression Suite

```bash
# Requires Node.js >= 22.0.0 (zero npm dependencies)
node review-materials/localhost-host-gate/mock-cdp-host-gate.mjs --repo <path-to-chuanban-repo>

# Run a single case
node review-materials/localhost-host-gate/mock-cdp-host-gate.mjs --repo <path-to-chuanban-repo> --case guest.localhost_non_host_blocked
```

### Red -> Green Summary (`v5.3.0@6a263b5` -> `fix/localhost-guest-host-gate`)

| Case ID | Unpatched `v5.3.0@6a263b5` | Patched (`fix/localhost-guest-host-gate`) |
| :--- | :--- | :--- |
| `guest.localhost_non_host_blocked` | `FAIL` (added 2 bindings) | `PASS` (0 bindings / 0 NewDocument / 0 inject / WS closed) |
| `guest.decoy_main_js_and_generic_app_config` | `FAIL` (added 2 bindings) | `PASS` (rejected `/main.js` + `#root` + `productName: 'my-app'` decoy) |
| `runtime.newdoc_null_document_element` | `FAIL` (`TypeError` at `core/runtime.js:502`) | `PASS` (0 exceptions; `DOMContentLoaded` deferred) |
| `guest.loading_then_domcontentloaded_non_host` | `FAIL` (`setAttribute` null exception) | `PASS` (`pending` while loading -> `non_host` after DCL -> detached) |
| `guest.heartbeat_zero_reattach` | `FAIL` (injected on tick 1) | `PASS` (7 sync ticks in `15.7s`: delta WS=0, inject=0) |
| `guest.same_tab_port_switch_and_external` | `FAIL` (injected on tick 1) | `PASS` (re-probed across `:4173 -> example.com -> :5173` & direct `:4173 -> :5173`) |
| `host.main_window_cold_boot_preserved` | `FAIL` (`NewDocument` threw at `L502`) | `PASS` (0 exceptions; full host injection preserved) |
| `host.dev_url_mode_preserved` | `PASS` | `PASS` (`electronNative` + `nativeStorage` recognized as host) |
| `host.swarm_iframe_preserved` | `PASS` | `PASS` (`plugin://swarm--*` exempted & injected) |
| `host.vscode_file_preserved` | `PASS` | `PASS` (`vscode-file://` exempted & injected) |
| `cli.verify_picks_host_over_guest` | `FAIL` (`doctor`/`verify` hit `pages[0]` guest) | `PASS` (`doctor`/`verify` skipped `pages[0]` guest and verified `pages[1]` host) |

## Live Before -> After Screenshot Index

All screenshots are sanitized pure-viewport captures (no chat sidebar, address bar, desktop pet, OS username, or session UUIDs). Note on versions:
- `before-v530-repro-4179.png`, `before-v530-blog-home.png`, and `before-v530-blog-archive.png` were captured natively on unpatched `v5.3.0@6a263b5` (pure `core/` mode with `customCss: false`, `customJs: false`).
- `before-light-host-night-page-crop.png` was captured on `v5.2.0` pure `core/` (cropped to pure viewport); static diff confirms the light-mode foreground/background variables in `core/theme.css` (`high-contrast`: `--background: #FCFCFB !important; --foreground: #1F1E1D !important`, `L530-561`) are identical in `v5.3.0@6a263b5`.
- All four `after-*` screenshots were captured natively on Windows 11 (`Node v22.22.2`) running the deployed `fix/localhost-guest-host-gate` patch in pure `core/` mode.

| Scenario | Before (Injection Collision) | After (Fixed) |
| :--- | :--- | :--- |
| Minimal dual-card + `Settings` button (`http://127.0.0.1:4179/`, Dark host) | [`screenshots/before-v530-repro-4179.png`](screenshots/before-v530-repro-4179.png) | [`screenshots/after-repro-4179.png`](screenshots/after-repro-4179.png) |
| Local static site home — Light warm paper (`http://127.0.0.1:4173/`, Dark host) | [`screenshots/before-v530-blog-home.png`](screenshots/before-v530-blog-home.png) | [`screenshots/after-blog-home-warm.png`](screenshots/after-blog-home-warm.png) |
| Local static site archive — Light warm paper (`http://127.0.0.1:4173/`, Dark host) | [`screenshots/before-v530-blog-archive.png`](screenshots/before-v530-blog-archive.png) | [`screenshots/after-blog-archive-warm.png`](screenshots/after-blog-archive-warm.png) |
| Local static site — Dark night theme (`http://127.0.0.1:4173/`, Light host) | [`screenshots/before-light-host-night-page-crop.png`](screenshots/before-light-host-night-page-crop.png) | [`screenshots/after-blog-home-night.png`](screenshots/after-blog-home-night.png) |

## Live Non-Regression Highlights (`live-non-regression-summary.json`)

Tested natively on Windows 11 (`Node v22.22.2`, stable channel) while `http://127.0.0.1:4173/` remained open in Antigravity's built-in browser:
- **Preset hot-reload**: `high-contrast` -> `claude-desktop-purewhite` -> `vintage-deep` -> restored `high-contrast` via `user/config.json` within 3.8s; `doctor`/`verify` skipped the open guest tab and validated `<antigravity-main-window>`.
- **`--safe-mode` & restore**: `node install.mjs verify --safe-mode` (`ok: true`, `hasUserStyle: false`, `dictCount: 1740`) and subsequent restore (`hasUserStyle: true`, `dictCount: 1741`); original `user/config.json` SHA-256 verified intact (`2F9C1F6C12AF927D4DEE6FF97B7B084A1A527EBCDD13DEDED88010E810D41AE9`).
- **Swarm iframe & live metrics capsule**: `plugin://swarm--swarm_board-<redacted>/` received hot-reloaded styles normally while guest `127.0.0.1` tabs had `0` repeated 15s heartbeat injections; `#ag-live-metrics-pill` stayed mounted (`+11 sub` active).
- **Packaging**: `node install.mjs pack` built and verified all 4 `core/` files against `core/manifest.json`. macOS and Linux paths were not natively executed on this Windows test host and rely on the Mock CDP suite for host-gate logic.
