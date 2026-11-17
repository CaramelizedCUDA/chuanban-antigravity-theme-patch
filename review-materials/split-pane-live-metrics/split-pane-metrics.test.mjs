import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

const REPO_DIR = path.resolve(import.meta.dirname, '../..');
const RUNTIME_PATH = path.join(REPO_DIR, 'core', 'runtime.js');
const DAEMON_PATH = path.join(REPO_DIR, 'core', 'daemon.mjs');
const CSS_PATH = path.join(REPO_DIR, 'core', 'theme.css');
const MANIFEST_PATH = path.join(REPO_DIR, 'core', 'manifest.json');

function createDomHarness({ url = 'https://127.0.0.1:8377/', cssText = '' } = {}) {
  const listeners = new Map();
  const resizeObservers = [];
  const intervals = new Map();
  let nextTimerId = 1;

  function parseSelectorAtom(atom) {
    const conds = [];
    let rest = atom.trim();
    if (!rest) return () => false;
    const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9_-]*/);
    if (tagMatch) {
      const tag = tagMatch[0].toUpperCase();
      conds.push((el) => el.tagName === tag);
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest[0] === '#') {
        const m = rest.match(/^#([A-Za-z0-9_.:-]+)/);
        if (!m) break;
        const idVal = m[1].replace(/\\/g, '');
        conds.push((el) => el.id === idVal);
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '.') {
        const m = rest.match(/^\.([A-Za-z0-9_-]+)/);
        if (!m) break;
        const cls = m[1];
        conds.push((el) => el.classList.contains(cls));
        rest = rest.slice(m[0].length);
      } else if (rest[0] === '[') {
        const m = rest.match(/^\[([^\]=^$*~|]+)(?:([*^$~|]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/);
        if (!m) break;
        const attr = m[1].trim();
        const op = m[2] || null;
        const val = m[3] ?? m[4] ?? m[5] ?? '';
        conds.push((el) => {
          if (!el.hasAttribute(attr)) return false;
          if (!op) return true;
          const actual = String(el.getAttribute(attr) ?? '');
          if (op === '=') return actual === val;
          if (op === '^=') return actual.startsWith(val);
          if (op === '*=') return actual.includes(val);
          return actual === val;
        });
        rest = rest.slice(m[0].length);
      } else {
        rest = rest.slice(1);
      }
    }
    return (el) => el && el.nodeType === 1 && conds.every((fn) => fn(el));
  }

  function splitTopLevel(str, sepChar) {
    const out = [];
    let cur = '';
    let br = 0;
    let pr = 0;
    let q = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (q) {
        cur += ch;
        if (ch === q && str[i - 1] !== '\\') q = '';
      } else if (ch === '"' || ch === "'") {
        q = ch;
        cur += ch;
      } else if (ch === '[') {
        br++;
        cur += ch;
      } else if (ch === ']') {
        if (br > 0) br--;
        cur += ch;
      } else if (ch === '(') {
        pr++;
        cur += ch;
      } else if (ch === ')') {
        if (pr > 0) pr--;
        cur += ch;
      } else if (ch === sepChar && br === 0 && pr === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function matchesSelector(el, selector) {
    const groups = splitTopLevel(String(selector || ''), ',');
    return groups.some((grp) => {
      const parts = grp.trim().split(/\s+/);
      if (parts.length === 1) return parseSelectorAtom(parts[0])(el);
      let idx = parts.length - 1;
      if (!parseSelectorAtom(parts[idx])(el)) return false;
      idx--;
      let cur = el.parentElement;
      while (cur && idx >= 0) {
        if (parts[idx] === '>') {
          idx--;
          if (idx < 0 || !parseSelectorAtom(parts[idx])(cur)) return false;
          idx--;
          cur = cur.parentElement;
        } else if (parseSelectorAtom(parts[idx])(cur)) {
          idx--;
          cur = cur.parentElement;
        } else {
          cur = cur.parentElement;
        }
      }
      return idx < 0;
    });
  }

  class MiniElement {
    constructor(tagName = 'div') {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this._attrs = new Map();
      this._listeners = new Map();
      this._html = '';
      this._text = '';
      this.style = {
        _props: new Map(),
        setProperty(k, v) {
          this._props.set(k, v);
        },
        removeProperty(k) {
          this._props.delete(k);
        },
        getPropertyValue(k) {
          return this._props.get(k) || '';
        },
        display: '',
        left: '',
        bottom: '',
        top: '',
        colorScheme: ''
      };
      this.clientWidth = 0;
      this.offsetWidth = 0;
      this.offsetHeight = 0;
      this.scrollWidth = 0;
      this._rect = { left: 100, top: 900, width: 200, height: 22 };
      const self = this;
      this.classList = {
        _set() {
          return new Set(String(self.getAttribute('class') || '').split(/\s+/).filter(Boolean));
        },
        contains(c) {
          return this._set().has(c);
        },
        add(...cs) {
          const s = this._set();
          for (const c of cs) if (c) s.add(c);
          self.setAttribute('class', Array.from(s).join(' '));
        },
        remove(...cs) {
          const s = this._set();
          for (const c of cs) s.delete(c);
          self.setAttribute('class', Array.from(s).join(' '));
        }
      };
    }

    get parentNode() {
      return this.parentElement;
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.documentElement) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    get id() {
      return this._attrs.get('id') || '';
    }
    set id(v) {
      if (v === '' || v === null || v === undefined) this._attrs.delete('id');
      else this._attrs.set('id', String(v));
    }
    get className() {
      return this._attrs.get('class') || '';
    }
    set className(v) {
      if (v === '' || v === null || v === undefined) this._attrs.delete('class');
      else this._attrs.set('class', String(v));
    }
    get previousElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx > 0 ? this.parentElement.children[idx - 1] : null;
    }
    get nextElementSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      return idx >= 0 && idx + 1 < this.parentElement.children.length ? this.parentElement.children[idx + 1] : null;
    }
    get innerHTML() {
      return this._html;
    }
    set innerHTML(v) {
      this._html = String(v || '');
      const stripped = this._html.replace(/<[^>]+>/g, '');
      this._text = stripped;
      if (this.tagName === 'DIV' && this._html.includes('<span')) {
        this.children = [];
        const span = new MiniElement('span');
        const idm = this._html.match(/id="([^"]+)"/);
        if (idm) span.id = idm[1];
        const clsm = this._html.match(/class="([^"]+)"/);
        if (clsm) span.className = clsm[1];
        this.appendChild(span);
      }
    }
    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => c.textContent).join('') || this._text;
      }
      return this._text;
    }
    set textContent(v) {
      this._text = String(v || '');
      this._html = this._text;
    }
    setAttribute(k, v) {
      this._attrs.set(String(k), String(v));
    }
    getAttribute(k) {
      return this._attrs.has(String(k)) ? this._attrs.get(String(k)) : null;
    }
    hasAttribute(k) {
      return this._attrs.has(String(k));
    }
    removeAttribute(k) {
      this._attrs.delete(String(k));
    }
    appendChild(child) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx !== -1) child.parentElement.children.splice(idx, 1);
      }
      const rIdx = this.children.indexOf(ref);
      child.parentElement = this;
      if (rIdx === -1) this.children.push(child);
      else this.children.splice(rIdx, 0, child);
      return child;
    }
    after(node) {
      if (!this.parentElement) return;
      if (node.parentElement) {
        const oldIdx = node.parentElement.children.indexOf(node);
        if (oldIdx !== -1) node.parentElement.children.splice(oldIdx, 1);
      }
      const idx = this.parentElement.children.indexOf(this);
      node.parentElement = this.parentElement;
      this.parentElement.children.splice(idx + 1, 0, node);
    }
    remove() {
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx !== -1) this.parentElement.children.splice(idx, 1);
        this.parentElement = null;
      }
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    matches(sel) {
      return matchesSelector(this, sel);
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matchesSelector(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const res = [];
      const walk = (node) => {
        for (const ch of node.children) {
          if (matchesSelector(ch, sel)) res.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return res;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    addEventListener(evt, fn) {
      if (!this._listeners.has(evt)) this._listeners.set(evt, []);
      this._listeners.get(evt).push(fn);
    }
    dispatchEvent(evt) {
      const list = this._listeners.get(evt.type) || [];
      for (const fn of list) fn(evt);
    }
    getBoundingClientRect() {
      return this._rect;
    }
  }

  const html = new MiniElement('html');
  const head = new MiniElement('head');
  const body = new MiniElement('body');
  body.setAttribute('class', 'dark');
  html.appendChild(head);
  html.appendChild(body);

  const doc = {
    documentElement: html,
    head,
    body,
    hidden: false,
    readyState: 'complete',
    createElement(tag) {
      return new MiniElement(tag);
    },
    getElementsByTagName(tag) {
      const t = tag.toUpperCase();
      if (t === 'HEAD') return [head];
      if (t === 'BODY') return [body];
      return html.querySelectorAll(tag);
    },
    getElementById(id) {
      if (html.id === id) return html;
      return html.querySelectorAll('[id]').find((el) => el.id === id) || null;
    },
    querySelectorAll(sel) {
      const out = [];
      if (matchesSelector(html, sel)) out.push(html);
      out.push(...html.querySelectorAll(sel));
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    addEventListener(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, []);
      listeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      const arr = listeners.get(evt);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    dispatchEvent(evt) {
      const arr = listeners.get(evt.type) || [];
      for (const fn of arr) fn(evt);
    }
  };

  let curUrl = new URL(url);
  const requests = [];
  const storageMap = new Map();
  class StorageCtor {}
  StorageCtor.prototype.getItem = (k) => (storageMap.has(k) ? storageMap.get(k) : null);
  StorageCtor.prototype.setItem = (k, v) => storageMap.set(k, String(v));

  class FakeResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
      this.disconnected = false;
      resizeObservers.push(this);
    }
    observe(el) {
      this.observed.push(el);
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger() {
      if (!this.disconnected) this.cb([], this);
    }
  }

  const pendingTimeouts = [];
  const win = {
    document: doc,
    location: {
      get href() {
        return curUrl.href;
      },
      get origin() {
        return curUrl.origin;
      },
      get protocol() {
        return curUrl.protocol;
      },
      get hostname() {
        return curUrl.hostname;
      },
      get pathname() {
        return curUrl.pathname;
      },
      get search() {
        return curUrl.search;
      },
      get hash() {
        return curUrl.hash;
      }
    },
    history: {
      state: null,
      pushState(_s, _t, nextUrl) {
        curUrl = new URL(nextUrl, curUrl.origin);
      },
      replaceState(_s, _t, nextUrl) {
        curUrl = new URL(nextUrl, curUrl.origin);
      }
    },
    navigator: { platform: 'Win32' },
    __APP_CONFIG__: { productName: 'antigravity' },
    localStorage: new StorageCtor(),
    Storage: StorageCtor,
    URL,
    URLSearchParams,
    WeakMap,
    WeakSet,
    Map,
    Set,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame(fn) {
      const id = nextTimerId++;
      fn();
      return id;
    },
    cancelAnimationFrame() {},
    setTimeout(fn) {
      const id = nextTimerId++;
      pendingTimeouts.push({ id, fn });
      if (intervals.get('runTimersSync')) fn();
      return id;
    },
    clearTimeout(id) {
      const idx = pendingTimeouts.findIndex((t) => t.id === id);
      if (idx !== -1) pendingTimeouts.splice(idx, 1);
    },
    setInterval(fn) {
      const id = nextTimerId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    addEventListener(evt, fn) {
      doc.addEventListener('win:' + evt, fn);
    },
    removeEventListener(evt, fn) {
      doc.removeEventListener('win:' + evt, fn);
    },
    getComputedStyle() {
      return { color: 'rgb(243, 240, 228)', backgroundColor: 'rgb(36, 35, 32)', getPropertyValue: () => '' };
    },
    __agRequestMetrics(payload) {
      requests.push(payload);
    }
  };
  win.window = win;
  win.top = win;
  win.self = win;
  win.globalThis = win;

  const runtimeSrc = fs.readFileSync(RUNTIME_PATH, 'utf8');
  function runBoot({ enabled = true, version = '20261117-v5.4.2-test', modules = {} } = {}) {
    const payload = {
      version,
      platform: 'win32',
      enabled,
      preset: 'high-contrast',
      darkPreset: 'claude-warm',
      cssText,
      customCss: '',
      themeVars: {},
      darkThemeVars: {},
      i18nDict: {},
      modules: Object.assign({ i18n: false, metrics: true, deadlockHealer: false, coldBootHealer: false, zoomShortcuts: false }, modules),
      selectors: {},
      config: { enabled, preset: 'high-contrast', darkPreset: 'claude-warm' },
      customJs: ''
    };
    const code = runtimeSrc.replace('})(__AG_BOOT_PAYLOAD__);', `})(${JSON.stringify(payload)});`);
    vm.runInNewContext(code, win);
  }

  function createPane({ paneId, cascadeId = '', focused = true, rowW = 754, leftW = 147, rightW = 159, isHome = false } = {}) {
    const pane = new MiniElement('div');
    pane.setAttribute('data-pane-id', paneId);
    if (!focused) pane.setAttribute('data-pane-unfocused', '');

    const view = new MiniElement('div');
    view.setAttribute('data-testid', 'conversation-view');
    if (cascadeId) view.setAttribute('data-cascade-id', cascadeId);
    pane.appendChild(view);

    if (isHome) {
      const home = new MiniElement('div');
      home.setAttribute('data-testid', 'home-greeting');
      view.appendChild(home);
    }

    const box = new MiniElement('div');
    box.id = 'antigravity.agentSidePanelInputBox';
    const card = new MiniElement('div');
    card.className = 'surface-composer-card';
    const footer = new MiniElement('div');
    footer.className = 'agy-composer-footer';
    footer.clientWidth = rowW;

    const leftGroup = new MiniElement('div');
    const modelChip = new MiniElement('div');
    modelChip.offsetWidth = leftW;
    modelChip.scrollWidth = leftW;
    leftGroup.appendChild(modelChip);

    const rightGroup = new MiniElement('div');
    rightGroup.offsetWidth = rightW;

    footer.appendChild(leftGroup);
    footer.appendChild(rightGroup);
    card.appendChild(footer);
    box.appendChild(card);
    view.appendChild(box);
    body.appendChild(pane);
    return { pane, view, box, card, footer, leftGroup, rightGroup };
  }

  return {
    win,
    doc,
    body,
    requests,
    resizeObservers,
    setUrl(next) {
      curUrl = new URL(next);
    },
    runBoot,
    createPane,
    flushTimers() {
      const batch = pendingTimeouts.splice(0, pendingTimeouts.length);
      for (const item of batch) item.fn();
      return batch.length;
    },
    MiniElement
  };
}

test('2-pane & 3-pane split mounts independent pills, tooltips, and unique #ag-live-metrics-pill', () => {
  const cid1 = '11111111-1111-4111-8111-111111111111';
  const cid2 = '22222222-2222-4222-8222-222222222222';
  const cid3 = '33333333-3333-4333-8333-333333333333';
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${cid1}%2B${cid2}%2B${cid3}?project=sample-workspace&focused=${cid1}`
  });

  const p1 = h.createPane({ paneId: 'pane-1', cascadeId: cid1, focused: true, rowW: 754, leftW: 147, rightW: 159 });
  const p2 = h.createPane({ paneId: 'pane-4', cascadeId: cid2, focused: false, rowW: 754, leftW: 147, rightW: 159 });
  const p3 = h.createPane({ paneId: 'pane-2', cascadeId: cid3, focused: false, rowW: 754, leftW: 147, rightW: 159 });

  h.runBoot();

  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(h.requests[0]), [cid1, cid2, cid3]);

  const pills = h.doc.querySelectorAll('[data-ag-metrics-pill="1"]');
  assert.equal(pills.length, 3);
  assert.equal(h.doc.querySelectorAll('#ag-live-metrics-pill').length, 1);
  assert.equal(p1.box.querySelector('#ag-live-metrics-pill') !== null, true);
  assert.equal(p2.box.querySelector('#ag-live-metrics-pill'), null);
  assert.equal(p3.box.querySelector('#ag-live-metrics-pill'), null);

  // Push distinct metrics per cascadeId
  h.win.__ag_render_metrics({
    cascadeId: cid1,
    hasData: true,
    inlineHtml: '<span>9 tok/s·Hold 4.9s·Ctx 153k/512k (30%)·Out 48·+5 sub</span>',
    tooltipHtml: '<div>Tooltip Pane 1</div>'
  });
  h.win.__ag_render_metrics({
    cascadeId: cid2,
    hasData: true,
    inlineHtml: '<span>230 tok/s·TTFT 4.2s·Ctx 170k/512k (33%)·Out 1.1k</span>',
    tooltipHtml: '<div>Tooltip Pane 2</div>'
  });
  h.win.__ag_render_metrics({
    cascadeId: cid3,
    hasData: true,
    inlineHtml: '<span>120 tok/s·TTFT 2.1s·Ctx 45k/256k (18%)·Out 800</span>',
    tooltipHtml: '<div>Tooltip Pane 3</div>'
  });

  const pill1 = p1.box.querySelector('[data-ag-metrics-pill="1"]');
  const pill2 = p2.box.querySelector('[data-ag-metrics-pill="1"]');
  const pill3 = p3.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.match(pill1.textContent, /Hold 4\.9s/);
  assert.match(pill2.textContent, /230 tok\/s/);
  assert.match(pill3.textContent, /120 tok\/s/);
  assert.equal(pill1.style.display, 'inline-flex');
  assert.equal(pill2.style.display, 'inline-flex');
  assert.equal(pill3.style.display, 'inline-flex');

  // Independent WeakMap tooltips
  pill2.dispatchEvent({ type: 'mouseenter' });
  const tt = h.doc.getElementById('ag-live-metrics-tooltip');
  assert.equal(tt.getAttribute('data-visible'), '1');
  assert.equal(tt.innerHTML, '<div>Tooltip Pane 2</div>');
  pill2.dispatchEvent({ type: 'mouseleave' });
  assert.equal(tt.getAttribute('data-visible'), null);

  pill3.dispatchEvent({ type: 'mouseenter' });
  assert.equal(tt.innerHTML, '<div>Tooltip Pane 3</div>');

  // Switching focus to pane-2 moves unique #ag-live-metrics-pill
  p1.pane.setAttribute('data-pane-unfocused', '');
  p3.pane.removeAttribute('data-pane-unfocused');
  h.setUrl(`https://127.0.0.1:8377/c/${cid1}%2B${cid2}%2B${cid3}?focused=${cid3}`);
  h.win.__ag_check_route_fn();
  assert.equal(h.doc.querySelectorAll('#ag-live-metrics-pill').length, 1);
  assert.equal(p3.box.querySelector('#ag-live-metrics-pill') !== null, true);
  assert.equal(p1.box.querySelector('#ag-live-metrics-pill'), null);

  // Closing pane-2 prunes orphan pill and updates subscription
  p3.pane.remove();
  h.win.__ag_check_route_fn();
  assert.equal(h.doc.querySelectorAll('[data-ag-metrics-pill="1"]').length, 2);
  assert.deepEqual(JSON.parse(h.requests[h.requests.length - 1]), [cid1, cid2]);
});

test('mixed chat + home split isolates home pane without inheriting chat UUID', () => {
  const cid1 = '11111111-1111-4111-8111-111111111111';
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${cid1}?focused=${cid1}`
  });

  const pChat = h.createPane({ paneId: 'pane-1', cascadeId: cid1, focused: true });
  const pHome = h.createPane({ paneId: 'pane-2', cascadeId: '', focused: false, isHome: true });

  h.runBoot();
  assert.deepEqual(JSON.parse(h.requests[0]), [cid1]);

  h.win.__ag_render_metrics({
    cascadeId: cid1,
    hasData: true,
    inlineHtml: '<span>99 tok/s·TTFT 1.5s·Ctx 10k/256k (4%)·Out 200</span>',
    tooltipHtml: '<div>Chat Only</div>'
  });

  const chatPill = pChat.box.querySelector('[data-ag-metrics-pill="1"]');
  const homePill = pHome.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.equal(chatPill.style.display, 'inline-flex');
  assert.equal(homePill.getAttribute('data-ag-cascade-id'), null);
  assert.equal(homePill.style.display, 'none');
});

test('narrow split pane dynamically wraps to bottom when availMiddleW < neededPillW and avoids hysteresis oscillation', () => {
  const cid1 = '11111111-1111-4111-8111-111111111111';
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${cid1}`
  });

  // rowW=600, leftW=147, rightW=159 -> availMiddleW = 600 - 147 - 159 - 8 = 286px
  // Historically 286 >= 165 stayed in 'middle' and truncated 337px text with '...'!
  const p = h.createPane({ paneId: 'pane-1', cascadeId: cid1, focused: true, rowW: 600, leftW: 147, rightW: 159 });
  h.runBoot();

  const pill = p.box.querySelector('[data-ag-metrics-pill="1"]');
  const textEl = pill.querySelector('[data-ag-metrics-text="1"]');
  textEl.scrollWidth = 337; // neededPillW = 349, enterBottomPx = 349, exitBottomPx = 365

  h.win.__ag_render_metrics({
    cascadeId: cid1,
    hasData: true,
    inlineHtml: '<span>256 tok/s·TTFT 5.0s·Ctx 139k/512k (27%)·Out 2.2k·+4 sub</span>',
    tooltipHtml: '<div>Narrow</div>'
  });

  // 286 < 349 -> immediately wraps to bottom row (moved after footer inside card)
  assert.equal(pill.getAttribute('data-ag-row-mode'), 'bottom');
  assert.equal(p.footer.getAttribute('data-ag-row-mode'), 'bottom');
  assert.equal(pill.parentElement, p.card);
  assert.equal(pill.previousElementSibling, p.footer);

  // Widen to availMiddleW = 355 (between 349 and 365) -> stays bottom due to +16px hysteresis
  p.footer.clientWidth = 355 + 147 + 159 + 8;
  h.resizeObservers[0].trigger();
  assert.equal(pill.getAttribute('data-ag-row-mode'), 'bottom');

  // Widen to availMiddleW = 370 (>= 365) -> cleanly returns to middle inside leftGroup
  p.footer.clientWidth = 370 + 147 + 159 + 8;
  h.resizeObservers[0].trigger();
  assert.equal(pill.getAttribute('data-ag-row-mode'), 'middle');
  assert.equal(pill.parentElement, p.leftGroup);
});

test('!ENABLED cleanup and hot-reload stale pill eviction clean all instances and observers', () => {
  const cid1 = '11111111-1111-4111-8111-111111111111';
  const cid2 = '22222222-2222-4222-8222-222222222222';
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${cid1}%2B${cid2}`
  });

  h.createPane({ paneId: 'pane-1', cascadeId: cid1, focused: true });
  h.createPane({ paneId: 'pane-2', cascadeId: cid2, focused: false });
  h.runBoot({ version: '20261117-v5.4.2-v1' });
  assert.equal(h.doc.querySelectorAll('[data-ag-metrics-pill="1"]').length, 2);
  const oldObservers = [...h.resizeObservers];
  assert.equal(oldObservers.length, 2);

  // Hot-reload with newer version disconnects old observers and replaces stale pills
  h.runBoot({ version: '20261117-v5.4.2-v2' });
  assert.ok(oldObservers.every((ro) => ro.disconnected === true));
  const reloadedPills = h.doc.querySelectorAll('[data-ag-metrics-pill="1"]');
  assert.equal(reloadedPills.length, 2);
  assert.ok(reloadedPills.every((p) => p.getAttribute('data-ag-pill-ver') === '20261117-v5.4.2-v2'));

  // Disabling removes all pills, row-mode attributes, tooltip, and disconnects observers
  const v2Observers = h.resizeObservers.slice(2);
  h.runBoot({ enabled: false, version: '20261117-v5.4.2-v2' });
  assert.equal(h.doc.querySelectorAll('[data-ag-metrics-pill="1"], #ag-live-metrics-pill, .ag-live-metrics-pill').length, 0);
  assert.equal(h.doc.querySelectorAll('[data-ag-row-mode]').length, 0);
  assert.equal(h.doc.getElementById('ag-live-metrics-tooltip'), null);
  assert.ok(v2Observers.every((ro) => ro.disconnected === true));
});

test('daemon.mjs normalizeCascadeIdList & parseMetricsSubscriptionPayload handle single, array, empty, encoded & capped lists', () => {
  const daemonSrc = fs.readFileSync(DAEMON_PATH, 'utf8');
  const start = daemonSrc.indexOf('const CASCADE_UUID_RE =');
  const end = daemonSrc.indexOf('function attachTarget(');
  assert.ok(start !== -1 && end > start, 'daemon subscription helpers must exist');
  const snippet = daemonSrc.slice(start, end);
  const ctx = {};
  vm.runInNewContext(
    `${snippet}\nthis.normalizeCascadeIdList = normalizeCascadeIdList;\nthis.parseMetricsSubscriptionPayload = parseMetricsSubscriptionPayload;`,
    ctx
  );

  const u1 = '11111111-1111-4111-8111-111111111111';
  const u2 = '22222222-2222-4222-8222-222222222222';
  const u3 = '33333333-3333-4333-8333-333333333333';

  const parse = (input) => JSON.parse(JSON.stringify(ctx.parseMetricsSubscriptionPayload(input)));
  assert.deepEqual(parse(u1), { valid: true, ids: [u1.toLowerCase()] });
  assert.deepEqual(parse(JSON.stringify([u1, u2, u1, 'bad-id', u3])), {
    valid: true,
    ids: [u1.toLowerCase(), u2, u3]
  });
  assert.deepEqual(parse('[]'), { valid: true, ids: [] });
  assert.deepEqual(parse(`${u1}%2B${u2}`), {
    valid: true,
    ids: [u1.toLowerCase(), u2]
  });
  assert.deepEqual(parse('not-a-uuid'), { valid: false, ids: [] });

  // Verify cap at 12
  const many = Array.from({ length: 15 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.equal(ctx.normalizeCascadeIdList(many).length, 12);
});

test('recreated pane B restores cached metrics during another pane update & clears uncached navigation', () => {
  const cidA = '11111111-1111-4111-8111-111111111111';
  const cidB = '22222222-2222-4222-8222-222222222222';
  const cidC = '33333333-3333-4333-8333-333333333333';
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${cidA}%2B${cidB}?focused=${cidA}`
  });

  const pA = h.createPane({ paneId: 'pane-1', cascadeId: cidA, focused: true });
  const pB = h.createPane({ paneId: 'pane-2', cascadeId: cidB, focused: false });
  h.runBoot();

  h.win.__ag_render_metrics({
    cascadeId: cidA,
    hasData: true,
    inlineHtml: '<span>A1</span>',
    tooltipHtml: '<div>Tip A1</div>'
  });
  h.win.__ag_render_metrics({
    cascadeId: cidB,
    hasData: true,
    inlineHtml: '<span>B1</span>',
    tooltipHtml: '<div>Tip B1</div>'
  });

  // Pane B composer recreates (new pill with empty display '') before checkRouteAndMountMetrics runs,
  // and pane A pushes an update first.
  pB.pane.remove();
  const pBRecreated = h.createPane({ paneId: 'pane-2', cascadeId: cidB, focused: false });
  h.win.__ag_render_metrics({
    cascadeId: cidA,
    hasData: true,
    inlineHtml: '<span>A2</span>',
    tooltipHtml: '<div>Tip A2</div>'
  });

  const pillB = pBRecreated.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.ok(pillB, 'recreated pane B must receive a pill');
  assert.equal(pillB.getAttribute('data-ag-cascade-id'), cidB);
  assert.equal(pillB.getAttribute('data-ag-rendered-cid'), cidB);
  assert.equal(pillB.style.display, 'inline-flex');
  assert.equal(pillB.textContent, 'B1');

  // Route check stays consistent
  h.win.__ag_check_route_fn();
  assert.equal(pillB.style.display, 'inline-flex');
  assert.equal(pillB.textContent, 'B1');

  // Navigating pane A's reused composer to uncached cidC while an in-flight cidA push arrives
  // clears stale A inline text immediately instead of leaving A2 visible under cidC.
  pA.view.setAttribute('data-cascade-id', cidC);
  h.setUrl(`https://127.0.0.1:8377/c/${cidC}%2B${cidB}?focused=${cidC}`);
  h.win.__ag_render_metrics({
    cascadeId: cidA,
    hasData: true,
    inlineHtml: '<span>A3</span>',
    tooltipHtml: '<div>Tip A3</div>'
  });

  const pillA = pA.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.equal(pillA.getAttribute('data-ag-cascade-id'), cidC);
  assert.equal(pillA.getAttribute('data-ag-rendered-cid'), null);
  assert.equal(pillA.style.display, 'none');
  assert.equal(pillA.textContent, '');
});

test('same-version reinjection keeps hover tooltip synchronized on retained pills', () => {
  const cid1 = '11111111-1111-4111-8111-111111111111';
  const sameVer = '20261117-v5.4.2-same-ver';
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${cid1}`
  });

  const p1 = h.createPane({ paneId: 'pane-1', cascadeId: cid1, focused: true });
  h.runBoot({ version: sameVer });

  h.win.__ag_render_metrics({
    cascadeId: cid1,
    hasData: true,
    inlineHtml: '<span>A-old</span>',
    tooltipHtml: '<div>Tooltip A-old</div>'
  });

  const originalPill = p1.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.ok(originalPill);
  originalPill.dispatchEvent({ type: 'mouseenter' });
  const tt = h.doc.getElementById('ag-live-metrics-tooltip');
  assert.equal(tt.innerHTML, '<div>Tooltip A-old</div>');
  originalPill.dispatchEvent({ type: 'mouseleave' });

  // Reinject exact same version -> existing pill element is retained rather than recreated
  h.runBoot({ version: sameVer });
  assert.equal(p1.box.querySelector('[data-ag-metrics-pill="1"]'), originalPill);

  h.win.__ag_render_metrics({
    cascadeId: cid1,
    hasData: true,
    inlineHtml: '<span>A-new</span>',
    tooltipHtml: '<div>Tooltip A-new</div>'
  });

  assert.equal(originalPill.textContent, 'A-new');
  originalPill.dispatchEvent({ type: 'mouseenter' });
  assert.equal(h.doc.getElementById('ag-live-metrics-tooltip').innerHTML, '<div>Tooltip A-new</div>');
});

test('side-question (/btw) sibling DOM & strip fallback mount independent pills while blank draft stays hidden and tab click re-checks route', () => {
  const mainCid = '11111111-1111-4111-8111-111111111111';
  const sideCid = '44444444-4444-4444-8444-444444444444';
  const sideCid2 = '55555555-5555-4555-8555-555555555555';

  const buildSideBox = (h, { sideConvCid = '', activeTabId = '', rowW = 754 } = {}) => {
    const auxSplit = new h.MiniElement('div');
    auxSplit.setAttribute('data-testid', 'aux-pane-split');

    const strip = new h.MiniElement('div');
    strip.setAttribute('data-side-panel-strip', '1');
    if (activeTabId) strip.setAttribute('data-active-tab-id', activeTabId);
    const tabBtn = new h.MiniElement('button');
    tabBtn.setAttribute('data-tab-id', activeTabId || 'new_side_question');
    const tabLabel = new h.MiniElement('span');
    strip.appendChild(tabBtn);
    tabBtn.appendChild(tabLabel);
    auxSplit.appendChild(strip);

    const content = new h.MiniElement('div');
    content.setAttribute('data-testid', 'side-question-tab-content');
    auxSplit.appendChild(content);

    let sideConv = null;
    if (sideConvCid) {
      sideConv = new h.MiniElement('div');
      sideConv.setAttribute('data-testid', 'side-question-tab-conversation');
      sideConv.setAttribute('data-cascade-id', sideConvCid);
      content.appendChild(sideConv);
    }

    const composerWrap = new h.MiniElement('div');
    composerWrap.setAttribute('data-testid', 'side-question-tab-composer');
    composerWrap.setAttribute('data-side-panel-composer', '1');
    const box = new h.MiniElement('div');
    box.id = 'antigravity.agentSidePanelInputBox';
    const card = new h.MiniElement('div');
    card.className = 'surface-composer-card';
    const footer = new h.MiniElement('div');
    footer.className = 'agy-composer-footer';
    footer.clientWidth = rowW;
    const leftGroup = new h.MiniElement('div');
    const chip = new h.MiniElement('div');
    chip.offsetWidth = 147;
    chip.scrollWidth = 147;
    leftGroup.appendChild(chip);
    const rightGroup = new h.MiniElement('div');
    rightGroup.offsetWidth = 159;
    footer.appendChild(leftGroup);
    footer.appendChild(rightGroup);
    card.appendChild(footer);
    box.appendChild(card);
    composerWrap.appendChild(box);
    content.appendChild(composerWrap);

    h.body.appendChild(auxSplit);
    return { auxSplit, strip, tabBtn, tabLabel, content, sideConv, composerWrap, box, footer };
  };

  // Case A: main pane + active /btw sibling DOM layout
  const h = createDomHarness({
    url: `https://127.0.0.1:8377/c/${mainCid}?tab=side_question__${sideCid}`
  });
  const pMain = h.createPane({ paneId: 'pane-1', cascadeId: mainCid, focused: true, rowW: 394 });
  const side = buildSideBox(h, { sideConvCid: sideCid, activeTabId: `side_question__${sideCid}` });

  h.runBoot();
  assert.deepEqual(JSON.parse(h.requests[h.requests.length - 1]), [mainCid, sideCid]);

  h.win.__ag_render_metrics({
    cascadeId: mainCid,
    hasData: true,
    inlineHtml: '<span>Main Metrics</span>',
    tooltipHtml: '<div>Tip Main</div>'
  });
  h.win.__ag_render_metrics({
    cascadeId: sideCid,
    hasData: true,
    inlineHtml: '<span>Side Metrics</span>',
    tooltipHtml: '<div>Tip Side</div>'
  });

  const mainPill = pMain.box.querySelector('[data-ag-metrics-pill="1"]');
  const sidePill = side.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.ok(mainPill && sidePill);
  assert.equal(h.doc.querySelectorAll('#ag-live-metrics-pill').length, 1);
  assert.equal(mainPill.id, 'ag-live-metrics-pill');
  assert.equal(sidePill.id, '');
  assert.equal(sidePill.getAttribute('data-ag-cascade-id'), sideCid);
  assert.equal(mainPill.style.display, 'inline-flex');
  assert.equal(sidePill.style.display, 'inline-flex');
  assert.equal(mainPill.textContent, 'Main Metrics');
  assert.equal(sidePill.textContent, 'Side Metrics');

  // Switch side-question tab via [data-active-tab-id] strip fallback + click listener on [data-tab-id]
  if (side.sideConv) side.sideConv.remove();
  side.strip.setAttribute('data-active-tab-id', `side_question__${sideCid2}`);
  h.flushTimers();
  h.doc.dispatchEvent({ type: 'click', target: side.tabLabel });
  assert.ok(h.flushTimers() >= 1, 'clicking [data-tab-id] descendant schedules route re-check');
  assert.deepEqual(JSON.parse(h.requests[h.requests.length - 1]), [mainCid, sideCid2]);
  assert.equal(sidePill.getAttribute('data-ag-cascade-id'), sideCid2);
  assert.equal(sidePill.style.display, 'none');

  h.win.__ag_render_metrics({
    cascadeId: sideCid2,
    hasData: true,
    inlineHtml: '<span>Side Tab 2</span>',
    tooltipHtml: '<div>Tip Side 2</div>'
  });
  assert.equal(sidePill.style.display, 'inline-flex');
  assert.equal(sidePill.textContent, 'Side Tab 2');

  // Case B: blank unsent /btw composer (even when totalBoxes === 1) must NOT inherit mainCid from URL
  const hBlank = createDomHarness({
    url: `https://127.0.0.1:8377/c/${mainCid}`
  });
  const blankSide = buildSideBox(hBlank, { sideConvCid: '', activeTabId: 'side_question__draft' });
  hBlank.runBoot();
  hBlank.win.__ag_render_metrics({
    cascadeId: mainCid,
    hasData: true,
    inlineHtml: '<span>Parent Leak Check</span>',
    tooltipHtml: '<div>Should Not Show</div>'
  });
  const blankPill = blankSide.box.querySelector('[data-ag-metrics-pill="1"]');
  assert.ok(blankPill);
  assert.equal(blankPill.getAttribute('data-ag-cascade-id'), null);
  assert.equal(blankPill.style.display, 'none');
  assert.equal(blankPill.textContent, '');
});

test('daemon.mjs fallback expression & runtime extractAllPathnameCascadeIds extract ?tab=side_question__, side-question-tab-conversation & data-active-tab-id', () => {
  const mainCid = '11111111-1111-4111-8111-111111111111';
  const sideCid = '44444444-4444-4444-8444-444444444444';
  const sideCid3 = '66666666-6666-4666-8666-666666666666';

  // 1. Runtime early-boot 0-box fallback includes ?tab=side_question__<uuid>
  const hZero = createDomHarness({
    url: `https://127.0.0.1:8377/c/${mainCid}?tab=side_question__${sideCid.toUpperCase()}`
  });
  hZero.runBoot();
  assert.deepEqual(JSON.parse(hZero.requests[hZero.requests.length - 1]), [mainCid, sideCid]);

  // 2. Daemon fallback Runtime.evaluate expression extraction
  const daemonSrc = fs.readFileSync(DAEMON_PATH, 'utf8');
  const marker = 'const syncMetricsForSession = async';
  const syncStart = daemonSrc.indexOf(marker);
  const exprStart = daemonSrc.indexOf('expression: `(function(){', syncStart);
  const exprEnd = daemonSrc.indexOf('returnByValue: true', exprStart);
  assert.ok(exprStart !== -1 && exprEnd > exprStart, 'daemon fallback expression must exist');
  const rawTemplate = daemonSrc.slice(exprStart + 'expression: `'.length, exprEnd);
  const closeTick = rawTemplate.lastIndexOf('`');
  const exprSrc = rawTemplate.slice(0, closeTick).replace(/\\\\/g, '\\');

  const makeMockDoc = (selectorMap) => ({
    querySelectorAll(sel) {
      return selectorMap[sel] || [];
    }
  });

  // 2a. With DOM nodes + URL ?tab=side_question__<uuid>
  const ctxDom = vm.createContext({
    URLSearchParams,
    window: {
      location: {
        pathname: `/c/${mainCid}`,
        search: `?tab=side_question__${sideCid}`
      }
    },
    document: makeMockDoc({
      '[data-testid="conversation-view"][data-cascade-id], [data-testid="side-question-tab-conversation"][data-cascade-id]':
        [
          { getAttribute: () => mainCid },
          { getAttribute: () => sideCid }
        ],
      '[data-active-tab-id^="side_question__"]': [
        { getAttribute: () => `side_question__${sideCid3}` }
      ],
      '[data-testid=conversation-row-sidebar][data-selected=true]': []
    })
  });
  const resDom = JSON.parse(JSON.stringify(vm.runInContext(exprSrc, ctxDom)));
  assert.deepEqual(resDom, [mainCid, sideCid, sideCid3]);

  // 2b. Early-boot with empty DOM extracts both main & side UUIDs from URL
  const ctxUrlOnly = vm.createContext({
    URLSearchParams,
    window: {
      location: {
        pathname: `/c/${mainCid}`,
        search: `?tab=side_question__${sideCid.toUpperCase()}`
      }
    },
    document: makeMockDoc({})
  });
  const resUrlOnly = JSON.parse(JSON.stringify(vm.runInContext(exprSrc, ctxUrlOnly)));
  assert.deepEqual(resUrlOnly, [mainCid, sideCid]);
});

test('core/theme.css and core/manifest.json multi-pane selectors & SHA-256 hashes stay synced', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  assert.ok(css.includes(':not(.ag-live-metrics-pill *):not([data-ag-metrics-pill] *)'));
  assert.ok(css.includes(':is(#ag-live-metrics-pill, .ag-live-metrics-pill)'));
  assert.ok(css.includes(':is(#ag-live-metrics-text, .ag-live-metrics-text)'));
  assert.ok(css.includes('flex: 0 1 auto !important'));

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  for (const [name, meta] of Object.entries(manifest.files)) {
    const buf = fs.readFileSync(path.join(REPO_DIR, 'core', name));
    const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(buf.length, meta.bytes, `${name} byte size mismatch`);
    assert.equal(actualSha, meta.sha256, `${name} sha256 mismatch`);
  }
});
