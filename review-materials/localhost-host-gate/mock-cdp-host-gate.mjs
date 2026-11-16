#!/usr/bin/env node
/**
 * Zero-dependency Mock CDP & VM E2E regression suite for Antigravity host gate.
 * Requires Node >= 22 (uses built-in node:http, node:crypto, node:vm, global WebSocket).
 *
 * Usage:
 *   node mock-cdp-host-gate.mjs [--repo <path>] [--case <case_id>]
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
function getArg(flag, fallback = null) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1);
  }
  return fallback;
}

const REPO_DIR = path.resolve(process.cwd(), getArg('--repo', path.resolve(__dirname, '..', 'fork-repo')));
const ONLY_CASE = getArg('--case', null);
const SANDBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-mock-cdp-'));

const USERNAME_LOWER = (() => {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
})();

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeText(input) {
  let s = String(input ?? '').replace(/\r\n/g, '\n');
  const home = os.homedir();
  const replacements = [
    [REPO_DIR, '<REPO>'],
    [REPO_DIR.replace(/\\/g, '/'), '<REPO>'],
    [SANDBOX_ROOT, '<SANDBOX>'],
    [SANDBOX_ROOT.replace(/\\/g, '/'), '<SANDBOX>'],
    [home, '<HOME>'],
    [home.replace(/\\/g, '/'), '<HOME>']
  ];
  for (const [needle, label] of replacements) {
    if (needle) {
      s = s.replace(new RegExp(escapeRegExp(needle), 'gi'), label);
    }
  }
  if (USERNAME_LOWER && USERNAME_LOWER.length >= 2) {
    s = s.replace(new RegExp(escapeRegExp(USERNAME_LOWER), 'gi'), '<USER>');
  }
  // Redact any leftover Windows drive-letter absolute paths while preserving URL schemes like plugin://
  s = s.replace(/(^|[\s"'`(=\[{<,;])([A-Za-z]:[\\/][^\s"'`<>|)\],;]+)/g, '$1<ABS_PATH>');
  return s;
}

function displayRepoLabel(repoDir) {
  const rel = path.relative(__dirname, repoDir).replace(/\\/g, '/');
  if (!rel.startsWith('/') && !/^[A-Za-z]:/.test(rel)) {
    return sanitizeText(rel || '.');
  }
  return sanitizeText(path.basename(repoDir));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 8000, pollMs = 25, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await delay(pollMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// ============================================================================
// 1. Minimal CSS Selector Matcher & Fake Browser DOM for node:vm
// ============================================================================

function splitSelectorList(selStr) {
  const out = [];
  let cur = '';
  let bracket = 0;
  let paren = 0;
  let quote = '';
  const s = String(selStr || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[') {
      bracket++;
      cur += ch;
    } else if (ch === ']') {
      if (bracket > 0) bracket--;
      cur += ch;
    } else if (ch === '(') {
      paren++;
      cur += ch;
    } else if (ch === ')') {
      if (paren > 0) paren--;
      cur += ch;
    } else if (ch === ',' && bracket === 0 && paren === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseComplexSelector(sel) {
  // Split into segments joined by combinators (' ' or '>')
  const tokens = [];
  let cur = '';
  let bracket = 0;
  let paren = 0;
  let quote = '';
  const s = sel.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote && s[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[') {
      bracket++;
      cur += ch;
    } else if (ch === ']') {
      if (bracket > 0) bracket--;
      cur += ch;
    } else if (ch === '(') {
      paren++;
      cur += ch;
    } else if (ch === ')') {
      if (paren > 0) paren--;
      cur += ch;
    } else if (bracket === 0 && paren === 0 && (ch === '>' || /\s/.test(ch))) {
      if (cur) {
        tokens.push({ type: 'compound', value: cur });
        cur = '';
      }
      if (ch === '>') {
        if (tokens.length > 0 && tokens[tokens.length - 1].type === 'comb' && tokens[tokens.length - 1].value === ' ') {
          tokens[tokens.length - 1].value = '>';
        } else if (tokens.length === 0 || tokens[tokens.length - 1].type !== 'comb') {
          tokens.push({ type: 'comb', value: '>' });
        }
      } else {
        if (tokens.length > 0 && tokens[tokens.length - 1].type === 'compound') {
          tokens.push({ type: 'comb', value: ' ' });
        }
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push({ type: 'compound', value: cur });
  return tokens;
}

function unescapeCssIdent(raw) {
  return raw.replace(/\\(.)/g, '$1');
}

function matchesCompound(el, compound) {
  if (!el || el.nodeType !== 1) return false;
  let i = 0;
  const s = compound.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === '*') {
      i++;
      continue;
    }
    if (ch === '#') {
      i++;
      let ident = '';
      while (i < s.length && !['.', '#', '[', ':'].includes(s[i])) {
        if (s[i] === '\\' && i + 1 < s.length) {
          ident += s[i + 1];
          i += 2;
        } else {
          ident += s[i++];
        }
      }
      if (el.getAttribute('id') !== ident) return false;
      continue;
    }
    if (ch === '.') {
      i++;
      let cls = '';
      while (i < s.length && !['.', '#', '[', ':'].includes(s[i])) {
        if (s[i] === '\\' && i + 1 < s.length) {
          cls += s[i + 1];
          i += 2;
        } else {
          cls += s[i++];
        }
      }
      if (!el.classList.contains(cls)) return false;
      continue;
    }
    if (ch === '[') {
      i++;
      let inner = '';
      let q = '';
      while (i < s.length) {
        const c = s[i++];
        if (q) {
          if (c === q && s[i - 2] !== '\\') q = '';
          inner += c;
        } else {
          if (c === '"' || c === "'") {
            q = c;
            inner += c;
          } else if (c === ']') {
            break;
          } else {
            inner += c;
          }
        }
      }
      const m = inner.match(/^([^\s=*^$~|]+)\s*(?:(\*=|\^=|\$=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/);
      if (!m) return false;
      const attrName = m[1].trim();
      const op = m[2];
      const expected = m[3] ?? m[4] ?? m[5] ?? '';
      if (!el.hasAttribute(attrName)) return false;
      if (op) {
        const actual = el.getAttribute(attrName) ?? '';
        if (op === '=' && actual !== expected) return false;
        if (op === '*=' && !actual.includes(expected)) return false;
        if (op === '^=' && !actual.startsWith(expected)) return false;
        if (op === '$=' && !actual.endsWith(expected)) return false;
      }
      continue;
    }
    if (ch === ':') {
      if (s.slice(i, i + 5) === ':not(') {
        i += 5;
        let depth = 1;
        let q = '';
        let inner = '';
        while (i < s.length && depth > 0) {
          const c = s[i++];
          if (q) {
            if (c === q && s[i - 2] !== '\\') q = '';
            inner += c;
          } else {
            if (c === '"' || c === "'") {
              q = c;
              inner += c;
            } else if (c === '(') {
              depth++;
              inner += c;
            } else if (c === ')') {
              depth--;
              if (depth > 0) inner += c;
            } else {
              inner += c;
            }
          }
        }
        if (matchesSelectorList(el, inner)) return false;
        continue;
      }
      // Ignore other pseudo-classes conservatively
      while (i < s.length && !['.', '#', '[', ':'].includes(s[i])) i++;
      continue;
    }
    // Tag name
    let tag = '';
    while (i < s.length && !['.', '#', '[', ':'].includes(s[i])) {
      tag += s[i++];
    }
    if (el.tagName.toLowerCase() !== unescapeCssIdent(tag).toLowerCase()) return false;
  }
  return true;
}

function matchesComplex(el, tokens) {
  if (!el || el.nodeType !== 1 || tokens.length === 0) return false;
  let idx = tokens.length - 1;
  if (tokens[idx].type !== 'compound' || !matchesCompound(el, tokens[idx].value)) {
    return false;
  }
  idx--;
  let cur = el;
  while (idx >= 0) {
    const comb = tokens[idx--];
    const prevComp = tokens[idx--];
    if (!comb || !prevComp || prevComp.type !== 'compound') return false;
    if (comb.value === '>') {
      cur = cur.parentElement;
      if (!cur || !matchesCompound(cur, prevComp.value)) return false;
    } else {
      let anc = cur.parentElement;
      let matched = false;
      while (anc) {
        if (matchesCompound(anc, prevComp.value)) {
          matched = true;
          cur = anc;
          break;
        }
        anc = anc.parentElement;
      }
      if (!matched) return false;
    }
  }
  return true;
}

function matchesSelectorList(el, selectorList) {
  if (!el || el.nodeType !== 1 || !selectorList) return false;
  const parts = splitSelectorList(selectorList);
  for (const part of parts) {
    const tokens = parseComplexSelector(part);
    if (matchesComplex(el, tokens)) return true;
  }
  return false;
}

class FakeStyle {
  constructor() {
    this._props = new Map();
    this.display = '';
    this.left = '';
    this.bottom = '';
    this.colorScheme = '';
    this.cssText = '';
  }
  setProperty(k, v) {
    this._props.set(String(k), String(v));
  }
  getPropertyValue(k) {
    return this._props.get(String(k)) || '';
  }
  removeProperty(k) {
    this._props.delete(String(k));
  }
}

class FakeClassList {
  constructor(el) {
    this._el = el;
  }
  _getSet() {
    const raw = this._el.getAttribute('class') || '';
    return new Set(raw.split(/\s+/).filter(Boolean));
  }
  _save(set) {
    this._el.setAttribute('class', Array.from(set).join(' '));
  }
  contains(cls) {
    return this._getSet().has(cls);
  }
  add(...tokens) {
    const s = this._getSet();
    for (const t of tokens) s.add(t);
    this._save(s);
  }
  remove(...tokens) {
    const s = this._getSet();
    for (const t of tokens) s.delete(t);
    this._save(s);
  }
}

class FakeNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let cur = this;
    while (cur) {
      if (this.ownerDocument && cur === this.ownerDocument.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  remove() {
    if (!this.parentNode) return;
    const arr = this.parentNode.childNodes;
    const idx = arr.indexOf(this);
    if (idx !== -1) arr.splice(idx, 1);
    this.parentNode = null;
  }
}

class FakeTextNode extends FakeNode {
  constructor(text, ownerDocument) {
    super(3, ownerDocument);
    this._value = String(text ?? '');
  }
  get nodeValue() {
    return this._value;
  }
  set nodeValue(v) {
    this._value = String(v ?? '');
  }
  get textContent() {
    return this._value;
  }
  set textContent(v) {
    this._value = String(v ?? '');
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super(1, ownerDocument);
    this.tagName = String(tagName || 'DIV').toUpperCase();
    this._attrs = new Map();
    this.style = new FakeStyle();
    this.classList = new FakeClassList(this);
    this._listeners = new Map();
    this.offsetWidth = 100;
    this.scrollWidth = 100;
    this.clientWidth = 400;
    this.offsetHeight = 20;
  }
  get id() {
    return this._attrs.get('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes.filter((n) => n.nodeType === 1);
    const idx = sibs.indexOf(this);
    return idx >= 0 && idx + 1 < sibs.length ? sibs[idx + 1] : null;
  }
  get previousElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.childNodes.filter((n) => n.nodeType === 1);
    const idx = sibs.indexOf(this);
    return idx > 0 ? sibs[idx - 1] : null;
  }
  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
  }
  getAttribute(name) {
    const k = String(name);
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  hasAttribute(name) {
    return this._attrs.has(String(name));
  }
  removeAttribute(name) {
    this._attrs.delete(String(name));
  }
  appendChild(child) {
    if (!child) return child;
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.remove();
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    this.childNodes.splice(idx, 0, newNode);
    return newNode;
  }
  after(...nodes) {
    if (!this.parentNode) return;
    const arr = this.parentNode.childNodes;
    const idx = arr.indexOf(this);
    if (idx === -1) return;
    let insertPos = idx + 1;
    for (const n of nodes) {
      if (typeof n === 'object' && n) {
        if (n.parentNode) n.remove();
        n.parentNode = this.parentNode;
        arr.splice(insertPos++, 0, n);
      }
    }
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const str = String(v ?? '');
    if (str.length > 0) {
      this.appendChild(new FakeTextNode(str, this.ownerDocument));
    }
  }
  get innerHTML() {
    return this.textContent;
  }
  set innerHTML(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    const s = String(v ?? '');
    const m = s.match(/^<span id="ag-live-metrics-text"><\/span>$/);
    if (m) {
      const span = new FakeElement('span', this.ownerDocument);
      span.id = 'ag-live-metrics-text';
      this.appendChild(span);
    } else if (s) {
      this.appendChild(new FakeTextNode(s, this.ownerDocument));
    }
  }
  matches(selector) {
    return matchesSelectorList(this, selector);
  }
  closest(selector) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (matchesSelectorList(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const res = [];
    const visit = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 1) {
          if (matchesSelectorList(ch, selector)) res.push(ch);
          visit(ch);
        }
      }
    };
    visit(this);
    return res;
  }
  getElementsByTagName(tag) {
    const t = String(tag || '').toLowerCase();
    const res = [];
    const visit = (node) => {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 1) {
          if (t === '*' || ch.tagName.toLowerCase() === t) res.push(ch);
          visit(ch);
        }
      }
    };
    visit(this);
    return res;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  getBoundingClientRect() {
    return { left: 100, top: 600, width: 120, height: 22, right: 220, bottom: 622 };
  }
  getContext() {
    return null;
  }
}

class FakeStorage {
  constructor() {
    this._map = new Map();
  }
  getItem(k) {
    const key = String(k);
    return this._map.has(key) ? this._map.get(key) : null;
  }
  setItem(k, v) {
    this._map.set(String(k), String(v));
  }
  removeItem(k) {
    this._map.delete(String(k));
  }
  clear() {
    this._map.clear();
  }
}

function makeEventTarget() {
  const map = new Map();
  return {
    _listeners: map,
    addEventListener(type, fn, opts) {
      if (typeof fn !== 'function') return;
      if (!map.has(type)) map.set(type, []);
      const list = map.get(type);
      const once = Boolean(opts && typeof opts === 'object' && opts.once);
      if (!list.some((x) => x.fn === fn)) {
        list.push({ fn, once });
      }
    },
    removeEventListener(type, fn) {
      const list = map.get(type);
      if (!list) return;
      const idx = list.findIndex((x) => x.fn === fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(type, evt = { type }) {
      const list = map.get(type);
      if (!list || list.length === 0) return;
      const snapshot = list.slice();
      for (const item of snapshot) {
        if (item.once) {
          this.removeEventListener(type, item.fn);
        }
        item.fn(evt);
      }
    },
    listenerCount(type) {
      return (map.get(type) || []).length;
    }
  };
}

function createBrowserVm(options = {}) {
  const timeouts = new Set();
  const intervals = new Set();

  const windowEvents = makeEventTarget();
  const docEvents = makeEventTarget();

  const doc = {
    readyState: options.readyState || 'complete',
    hidden: false,
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
    createTextNode(text) {
      return new FakeTextNode(text, doc);
    },
    getElementById(id) {
      if (!doc.documentElement) return null;
      if (doc.documentElement.getAttribute('id') === id) return doc.documentElement;
      const stack = [doc.documentElement];
      while (stack.length > 0) {
        const node = stack.shift();
        if (node.nodeType === 1) {
          if (node.getAttribute('id') === id) return node;
          for (const ch of node.childNodes) stack.push(ch);
        }
      }
      return null;
    },
    getElementsByTagName(tag) {
      if (!doc.documentElement) return [];
      const t = String(tag || '').toLowerCase();
      const out = [];
      if (t === '*' || doc.documentElement.tagName.toLowerCase() === t) {
        out.push(doc.documentElement);
      }
      out.push(...doc.documentElement.getElementsByTagName(tag));
      return out;
    },
    querySelector(sel) {
      if (!doc.documentElement) return null;
      if (matchesSelectorList(doc.documentElement, sel)) return doc.documentElement;
      return doc.documentElement.querySelector(sel);
    },
    querySelectorAll(sel) {
      if (!doc.documentElement) return [];
      const out = [];
      if (matchesSelectorList(doc.documentElement, sel)) out.push(doc.documentElement);
      out.push(...doc.documentElement.querySelectorAll(sel));
      return out;
    },
    createTreeWalker(root, whatToShow = 0xffffffff, filter = null) {
      const nodes = [];
      const traverse = (node) => {
        for (const ch of node.childNodes) {
          const typeBit = ch.nodeType === 1 ? 1 : ch.nodeType === 3 ? 4 : 0;
          let decision = 1; // FILTER_ACCEPT
          if (typeBit && (whatToShow & typeBit) !== 0) {
            if (filter && typeof filter.acceptNode === 'function') {
              decision = filter.acceptNode(ch);
            } else if (typeof filter === 'function') {
              decision = filter(ch);
            }
          } else {
            decision = 3; // FILTER_SKIP
          }
          if (decision === 2) continue; // FILTER_REJECT skips subtree
          if (decision === 1) nodes.push(ch);
          if (ch.nodeType === 1) traverse(ch);
        }
      };
      if (root) traverse(root);
      let cursor = -1;
      const walker = {
        currentNode: root,
        nextNode() {
          cursor++;
          if (cursor < nodes.length) {
            walker.currentNode = nodes[cursor];
            return walker.currentNode;
          }
          return null;
        }
      };
      return walker;
    },
    addEventListener: docEvents.addEventListener,
    removeEventListener: docEvents.removeEventListener,
    dispatchEvent: docEvents.dispatchEvent
  };

  function makeLocation(urlStr) {
    const u = new URL(urlStr);
    return {
      href: u.href,
      protocol: u.protocol,
      hostname: u.hostname,
      host: u.host,
      port: u.port,
      origin: u.origin,
      pathname: u.pathname,
      search: u.search,
      reload() {}
    };
  }

  const localStorage = new FakeStorage();
  const sessionStorage = new FakeStorage();

  const trackedSetTimeout = (fn, ms = 0, ...rest) => {
    const id = setTimeout(() => {
      timeouts.delete(id);
      fn(...rest);
    }, ms);
    timeouts.add(id);
    return id;
  };
  const trackedClearTimeout = (id) => {
    timeouts.delete(id);
    clearTimeout(id);
  };
  const trackedSetInterval = (fn, ms = 0, ...rest) => {
    const id = setInterval(() => fn(...rest), ms);
    intervals.add(id);
    return id;
  };
  const trackedClearInterval = (id) => {
    intervals.delete(id);
    clearInterval(id);
  };

  const windowObj = {
    location: makeLocation(options.url || 'http://127.0.0.1:4173/'),
    navigator: { platform: 'Win32', userAgent: 'MockChromium/1.0' },
    innerWidth: 1280,
    innerHeight: 800,
    document: doc,
    Storage: FakeStorage,
    localStorage,
    sessionStorage,
    history: { state: null, pushState() {}, replaceState() {} },
    performance: { now: () => 100, getEntriesByType: () => [] },
    URL,
    URLSearchParams,
    AbortController,
    TextEncoder,
    TextDecoder,
    console: { log() {}, warn() {}, error() {} },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({
      backgroundColor: '#FCFCFB',
      color: '#1F1E1D',
      getPropertyValue: (p) => (p === '--background' ? '#FCFCFB' : p === '--foreground' ? '#1F1E1D' : '#F7F5F0')
    }),
    fetch: async () => ({ ok: false, headers: { get: () => null } }),
    requestAnimationFrame: (cb) => trackedSetTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: trackedClearTimeout,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    dispatchEvent: windowEvents.dispatchEvent
  };
  windowObj.window = windowObj;
  windowObj.self = windowObj;
  windowObj.globalThis = windowObj;
  windowObj.top = options.isTopWindow === false ? { __isMockTop: true } : windowObj;
  windowObj.parent = windowObj.top;
  doc.defaultView = windowObj;

  if (options.electronNative) {
    windowObj.electronNative = {
      setTitleBarOverlay: () => Promise.resolve(),
      getZoomLevel: () => 1,
      zoomIn() {},
      zoomOut() {},
      resetZoom() {},
      wcvBrowser: { setThemeColor: () => Promise.resolve() }
    };
  }
  if (options.nativeStorage) {
    windowObj.nativeStorage = {
      getItems: async () => ({})
    };
  }
  if (options.appConfig !== undefined) {
    windowObj.__APP_CONFIG__ = options.appConfig;
  }

  const ctx = vm.createContext(windowObj);

  function buildInitialDom(domOpts = {}) {
    if (domOpts.nullDocumentElement) {
      doc.documentElement = null;
      doc.head = null;
      doc.body = null;
      return;
    }
    const html = doc.createElement('html');
    const head = doc.createElement('head');
    const body = doc.createElement('body');
    html.appendChild(head);
    html.appendChild(body);
    doc.documentElement = html;
    doc.head = head;
    doc.body = body;

    if (domOpts.hasJetboxCss) {
      const link = doc.createElement('link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', '/jetbox.css');
      head.appendChild(link);
    }
    if (domOpts.hasMainJsDecoy) {
      const sc = doc.createElement('script');
      sc.setAttribute('src', '/main.js');
      head.appendChild(sc);
    }
    if (domOpts.hasRootDecoy) {
      const root = doc.createElement('div');
      root.id = 'root';
      const btn = doc.createElement('button');
      btn.textContent = 'Settings';
      root.appendChild(btn);
      body.appendChild(root);
    } else if (typeof domOpts.setupBody === 'function') {
      domOpts.setupBody(doc, body, head, html);
    }
  }

  buildInitialDom(options);

  return {
    window: windowObj,
    document: doc,
    context: ctx,
    evaluate(code, filename = 'cdp-eval.js') {
      return vm.runInContext(code, ctx, { filename });
    },
    setUrl(nextUrl) {
      windowObj.location = makeLocation(nextUrl);
    },
    getDclListenerCount() {
      return windowEvents.listenerCount('DOMContentLoaded') + docEvents.listenerCount('DOMContentLoaded');
    },
    transitionToReady(readyOpts = {}) {
      if (!doc.documentElement) {
        buildInitialDom(readyOpts);
      } else if (typeof readyOpts.setupBody === 'function') {
        readyOpts.setupBody(doc, doc.body, doc.head, doc.documentElement);
      }
      if (readyOpts.hasJetboxCss && doc.head && !doc.querySelector('link[href*="/jetbox.css"]')) {
        const link = doc.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', '/jetbox.css');
        doc.head.appendChild(link);
      }
      if (readyOpts.appConfig !== undefined) {
        windowObj.__APP_CONFIG__ = readyOpts.appConfig;
      }
      doc.readyState = readyOpts.readyState || 'interactive';
      if (readyOpts.dispatchDcl !== false) {
        docEvents.dispatchEvent('DOMContentLoaded', { type: 'DOMContentLoaded' });
        windowEvents.dispatchEvent('DOMContentLoaded', { type: 'DOMContentLoaded' });
      }
    },
    resetPage(nextOpts = {}) {
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      timeouts.clear();
      intervals.clear();
      for (const k of Object.keys(windowObj)) {
        if (k.startsWith('__ag_') || k === '__APP_CONFIG__' || k === '__AG_PATCH_CTX__') {
          delete windowObj[k];
        }
      }
      windowEvents._listeners.clear();
      docEvents._listeners.clear();
      if (nextOpts.url) windowObj.location = makeLocation(nextOpts.url);
      windowObj.top = nextOpts.isTopWindow === false ? { __isMockTop: true } : windowObj;
      windowObj.parent = windowObj.top;
      if (nextOpts.electronNative) {
        windowObj.electronNative = {
          setTitleBarOverlay: () => Promise.resolve(),
          getZoomLevel: () => 1,
          zoomIn() {},
          zoomOut() {},
          resetZoom() {},
          wcvBrowser: { setThemeColor: () => Promise.resolve() }
        };
      } else {
        delete windowObj.electronNative;
      }
      if (nextOpts.nativeStorage) {
        windowObj.nativeStorage = { getItems: async () => ({}) };
      } else {
        delete windowObj.nativeStorage;
      }
      if (nextOpts.appConfig !== undefined) {
        windowObj.__APP_CONFIG__ = nextOpts.appConfig;
      }
      doc.readyState = nextOpts.readyState || 'complete';
      buildInitialDom(nextOpts);
    },
    destroy() {
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      timeouts.clear();
      intervals.clear();
    }
  };
}

// ============================================================================
// 2. Native RFC 6455 WebSocket + Mock CDP Server
// ============================================================================

function encodeWsFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf || ''), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function createMockCdpServer(initialTargets = []) {
  const targets = new Map();
  let listRequestCount = 0;
  const listWaiters = [];
  let newDocIdSeq = 1;

  function registerTarget(cfg) {
    const vmEnv = createBrowserVm(cfg.vm || {});
    const targetObj = {
      id: cfg.id,
      type: cfg.type || 'page',
      title: cfg.title || 'Mock Page',
      url: cfg.url,
      vm: vmEnv,
      sockets: new Set(),
      stats: {
        wsConnections: 0,
        wsClosedByClient: 0,
        bindingsAdded: [],
        newDocScriptsAdded: 0,
        newDocScriptsRemoved: 0,
        activeNewDocScripts: new Map(),
        probeCalls: 0,
        probeResults: [],
        fullInjectCount: 0,
        evalExceptions: [],
        methods: []
      },
      sendEvent(method, params = {}) {
        const frame = encodeWsFrame(0x1, JSON.stringify({ method, params }));
        for (const sock of targetObj.sockets) {
          if (!sock.destroyed && sock.writable) {
            sock.write(frame);
          }
        }
      },
      navigate(nextUrl, nextVmOpts = {}) {
        targetObj.url = nextUrl;
        vmEnv.resetPage({ ...nextVmOpts, url: nextUrl });
      }
    };
    targets.set(cfg.id, targetObj);
    return targetObj;
  }

  for (const cfg of initialTargets) {
    registerTarget(cfg);
  }

  let serverPort = 0;

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '').split('?')[0];
    if (reqPath === '/json/list' || reqPath === '/json') {
      listRequestCount += 1;
      const listPayload = Array.from(targets.values()).map((t) => ({
        id: t.id,
        type: t.type,
        title: t.title,
        url: t.url,
        webSocketDebuggerUrl: `ws://127.0.0.1:${serverPort}/devtools/page/${encodeURIComponent(t.id)}`
      }));
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(listPayload));
      while (listWaiters.length > 0 && listWaiters[0].count <= listRequestCount) {
        const w = listWaiters.shift();
        w.resolve(listRequestCount);
      }
      return;
    }
    res.writeHead(404, { Connection: 'close' });
    res.end('Not found');
  });

  server.on('upgrade', (req, socket) => {
    const reqPath = (req.url || '').split('?')[0];
    const m = reqPath.match(/^\/devtools\/page\/(.+)$/);
    const targetId = m ? decodeURIComponent(m[1]) : '';
    const target = targets.get(targetId);
    const key = req.headers['sec-websocket-key'];
    if (!target || !key) {
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        ''
      ].join('\r\n')
    );

    target.stats.wsConnections += 1;
    target.sockets.add(socket);

    let buf = Buffer.alloc(0);
    let fragChunks = [];
    let closedHandled = false;

    const sendJson = (obj) => {
      if (!socket.destroyed && socket.writable) {
        socket.write(encodeWsFrame(0x1, JSON.stringify(obj)));
      }
    };

    const handleTextMessage = (rawText) => {
      let msg;
      try {
        msg = JSON.parse(rawText);
      } catch {
        return;
      }
      const { id, method, params = {} } = msg;
      target.stats.methods.push(method);

      if (method === 'Page.enable' || method === 'Runtime.enable') {
        sendJson({ id, result: {} });
        return;
      }
      if (method === 'Runtime.addBinding') {
        const bName = String(params.name || '');
        if (bName) {
          target.stats.bindingsAdded.push(bName);
          target.vm.window[bName] = (payload) => {
            target.sendEvent('Runtime.bindingCalled', { name: bName, payload: String(payload ?? '') });
          };
        }
        sendJson({ id, result: {} });
        return;
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        const identifier = `mock-newdoc-${newDocIdSeq++}`;
        target.stats.newDocScriptsAdded += 1;
        target.stats.activeNewDocScripts.set(identifier, String(params.source || ''));
        sendJson({ id, result: { identifier } });
        return;
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
        const identifier = String(params.identifier || '');
        target.stats.newDocScriptsRemoved += 1;
        target.stats.activeNewDocScripts.delete(identifier);
        sendJson({ id, result: {} });
        return;
      }
      if (method === 'Page.reload') {
        sendJson({ id, result: {} });
        return;
      }
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        const isFullInject =
          expr.length > 5000 && expr.includes('__ag_patch_version') && expr.includes('ag-custom-fonts');
        if (isFullInject) {
          target.stats.fullInjectCount += 1;
        }
        try {
          const val = target.vm.evaluate(expr, isFullInject ? 'core/runtime.js' : 'cdp-eval.js');
          if (!isFullInject && (val === 'host' || val === 'non_host' || val === 'pending')) {
            target.stats.probeCalls += 1;
            target.stats.probeResults.push(val);
          } else if (!isFullInject && val && typeof val === 'object' && 'kind' in val) {
            target.stats.probeCalls += 1;
            target.stats.probeResults.push(val.kind);
          }
          if (val === undefined) {
            sendJson({ id, result: { result: { type: 'undefined' } } });
          } else {
            sendJson({ id, result: { result: { type: typeof val, value: val } } });
          }
        } catch (err) {
          const stackStr = sanitizeText(String(err?.stack || ''));
          const msgStr = sanitizeText(String(err?.message || err));
          target.stats.evalExceptions.push({ name: err?.name || 'Error', message: msgStr, stack: stackStr });
          sendJson({
            id,
            result: {
              result: { type: 'object', subtype: 'error', description: `${err?.name || 'Error'}: ${msgStr}` },
              exceptionDetails: {
                text: 'Uncaught',
                exception: {
                  type: 'object',
                  subtype: 'error',
                  className: err?.name || 'Error',
                  description: `${err?.name || 'Error'}: ${msgStr}\n${stackStr}`
                }
              }
            }
          });
        }
        return;
      }

      sendJson({ id, result: {} });
    };

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (buf.length < offset + 2) break;
          len = buf.readUInt16BE(offset);
          offset += 2;
        } else if (len === 127) {
          if (buf.length < offset + 8) break;
          len = Number(buf.readBigUInt64BE(offset));
          offset += 8;
        }

        let maskKey = null;
        if (masked) {
          if (buf.length < offset + 4) break;
          maskKey = buf.subarray(offset, offset + 4);
          offset += 4;
        }

        if (buf.length < offset + len) break;

        const payload = Buffer.from(buf.subarray(offset, offset + len));
        buf = buf.subarray(offset + len);

        if (masked && maskKey) {
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i & 3];
          }
        }

        if (opcode === 0x8) {
          // Client close frame
          if (!closedHandled) {
            closedHandled = true;
            target.stats.wsClosedByClient += 1;
          }
          try {
            socket.write(encodeWsFrame(0x8, payload.subarray(0, 2)));
            socket.end();
          } catch {}
          return;
        }
        if (opcode === 0x9) {
          // Ping -> Pong
          try {
            socket.write(encodeWsFrame(0xA, payload));
          } catch {}
          continue;
        }
        if (opcode === 0xA) {
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          fragChunks.push(payload);
          if (fin) {
            const fullBuf = fragChunks.length === 1 ? fragChunks[0] : Buffer.concat(fragChunks);
            fragChunks = [];
            handleTextMessage(fullBuf.toString('utf8'));
          }
        }
      }
    });

    const onClose = () => {
      target.sockets.delete(socket);
    };
    socket.on('close', onClose);
    socket.on('error', onClose);
  });

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          serverPort = server.address().port;
          resolve();
        });
      });
      return serverPort;
    },
    get port() {
      return serverPort;
    },
    getTarget(id) {
      return targets.get(id);
    },
    getListRequestCount() {
      return listRequestCount;
    },
    waitForListCount(n, timeoutMs = 25000) {
      if (listRequestCount >= n) return Promise.resolve(listRequestCount);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for /json/list #${n} (got ${listRequestCount})`));
        }, timeoutMs);
        listWaiters.push({
          count: n,
          resolve: (c) => {
            clearTimeout(timer);
            resolve(c);
          }
        });
        listWaiters.sort((a, b) => a.count - b.count);
      });
    },
    async close() {
      for (const t of targets.values()) {
        for (const s of t.sockets) {
          try {
            s.destroy();
          } catch {}
        }
        t.vm.destroy();
      }
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

// ============================================================================
// 3. Sandbox & Child Process Helpers
// ============================================================================

function createIsolatedEnv(name, cdpPort) {
  const dir = fs.mkdtempSync(path.join(SANDBOX_ROOT, `${name}-`));
  const appData = path.join(dir, 'AppData', 'Roaming');
  const localAppData = path.join(dir, 'AppData', 'Local');
  const xdgConfig = path.join(dir, '.config');
  const convDir = path.join(dir, 'conversations');
  const tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(convDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const portContent = `${cdpPort}\n/devtools/browser/mock\n`;
  const portFilePaths = [
    path.join(dir, 'DevToolsActivePort'),
    path.join(appData, 'Antigravity', 'DevToolsActivePort'),
    path.join(dir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
    path.join(xdgConfig, 'Antigravity', 'DevToolsActivePort')
  ];
  for (const pf of portFilePaths) {
    fs.mkdirSync(path.dirname(pf), { recursive: true });
    fs.writeFileSync(pf, portContent, 'utf8');
  }

  const env = { ...process.env };
  delete env.ANTIGRAVITY_WSL_DISTRO;
  delete env.ANTIGRAVITY_APP_DATA_DIR;
  env.HOME = dir;
  env.USERPROFILE = dir;
  env.APPDATA = appData;
  env.LOCALAPPDATA = localAppData;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
  env.TMPDIR = tmpDir;

  return {
    dir,
    portFile: portFilePaths[0],
    convDir,
    env
  };
}

function startDaemonProcess(repoDir, sandbox, { once = false } = {}) {
  const daemonPath = path.join(repoDir, 'core', 'daemon.mjs');
  const daemonArgs = [
    '--disable-warning=ExperimentalWarning',
    daemonPath,
    '--safe-mode',
    '--port-file',
    sandbox.portFile,
    '--conversations-dir',
    sandbox.convDir
  ];
  if (once) daemonArgs.push('--once');

  const child = spawn(process.execPath, daemonArgs, {
    env: sandbox.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    get stdout() {
      return sanitizeText(stdout);
    },
    get stderr() {
      return sanitizeText(stderr);
    },
    waitExit(timeoutMs = 10000) {
      return Promise.race([
        exitPromise,
        delay(timeoutMs).then(() => {
          throw new Error(`Daemon did not exit within ${timeoutMs}ms`);
        })
      ]);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {}
        const done = await Promise.race([exitPromise.then(() => true), delay(2500).then(() => false)]);
        if (!done && child.exitCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {}
          await Promise.race([exitPromise, delay(1500)]);
        }
      }
    }
  };
}

function extractTrailingJson(stdout) {
  const s = String(stdout || '').trim();
  let idx = s.lastIndexOf('\n{');
  if (idx !== -1) idx += 1;
  else if (s.startsWith('{')) idx = 0;
  if (idx === -1) {
    // Fallback: scan all '{' from first to last
    for (let pos = 0; pos < s.length; pos++) {
      if (s[pos] === '{') {
        try {
          return JSON.parse(s.slice(pos));
        } catch {}
      }
    }
    throw new Error('Could not find JSON object in CLI output');
  }
  return JSON.parse(s.slice(idx));
}

function runInstallCli(repoDir, subcommand, sandbox, timeoutMs = 15000) {
  const installPath = path.join(repoDir, 'install.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', installPath, subcommand],
      {
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`install.mjs ${subcommand} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        status: code,
        stdout,
        stderr,
        sanitizedStdout: sanitizeText(stdout),
        sanitizedStderr: sanitizeText(stderr)
      });
    });
  });
}

function loadRuntimeScriptWithBoot(repoDir, bootOverrides = {}) {
  const coreDir = path.join(repoDir, 'core');
  const runtimeTpl = fs.readFileSync(path.join(coreDir, 'runtime.js'), 'utf8');
  const cssText = fs.readFileSync(path.join(coreDir, 'theme.css'), 'utf8');
  const i18nDict = JSON.parse(fs.readFileSync(path.join(coreDir, 'i18n.json'), 'utf8'));
  const boot = {
    version: '20261115-v5.3.0-test',
    platform: 'win32',
    enabled: true,
    preset: 'high-contrast',
    cssText,
    customCss: '',
    themeVars: {},
    i18nDict,
    modules: {
      i18n: true,
      metrics: false,
      composerWaxSeal: true,
      deadlockHealer: true,
      coldBootHealer: false,
      zoomShortcuts: true,
      customCss: false,
      customJs: false
    },
    selectors: {},
    config: { enabled: true, preset: 'high-contrast' },
    customJs: '',
    ...bootOverrides
  };
  assert(
    runtimeTpl.includes('})(__AG_BOOT_PAYLOAD__);'),
    'core/runtime.js must contain __AG_BOOT_PAYLOAD__ placeholder'
  );
  return runtimeTpl.replace('})(__AG_BOOT_PAYLOAD__);', () => `})(${JSON.stringify(boot)});`);
}

// ============================================================================
// 4. The 11 Regression Test Cases
// ============================================================================

const TEST_CASES = [
  {
    id: 'guest.localhost_non_host_blocked',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'guest-localhost-1',
          type: 'page',
          title: 'Local Static Site',
          url: 'http://127.0.0.1:4173/',
          vm: {
            url: 'http://127.0.0.1:4173/',
            readyState: 'complete',
            hasRootDecoy: true
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case1', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: false });
      try {
        const target = cdp.getTarget('guest-localhost-1');
        await waitFor(
          () => target.stats.wsClosedByClient >= 1 || target.stats.fullInjectCount >= 1,
          5000,
          30,
          'guest probe settle'
        );
        await delay(150);
        assert.ok(target.stats.bindingsAdded.length === 0, `expected 0 Runtime.addBinding, got ${target.stats.bindingsAdded.length}`);
        assert.ok(target.stats.newDocScriptsAdded === 0, `expected 0 NewDocument, got ${target.stats.newDocScriptsAdded}`);
        assert.ok(target.stats.fullInjectCount === 0, `expected 0 inject(), got ${target.stats.fullInjectCount}`);
        assert.ok(target.stats.probeResults.includes('non_host'), 'expected probe result non_host');
        assert.ok(target.stats.wsClosedByClient >= 1 && target.sockets.size === 0, 'expected daemon to close WS proactively');
        assert.ok(target.vm.document.getElementById('ag-custom-fonts') === null, 'guest DOM must not have #ag-custom-fonts');
        assert.ok(target.vm.document.documentElement.getAttribute('data-ag-wax-seal') === null, 'guest must not have data-ag-wax-seal');
        return '0 bindings / 0 NewDocument / 0 inject / probe=non_host -> WS closed';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'guest.decoy_main_js_and_generic_app_config',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'guest-decoy-1',
          type: 'page',
          title: 'My Vite App',
          url: 'http://localhost:5173/',
          vm: {
            url: 'http://localhost:5173/',
            readyState: 'complete',
            hasMainJsDecoy: true,
            hasRootDecoy: true,
            appConfig: { productName: 'my-app', env: 'dev' }
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case2', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: false });
      try {
        const target = cdp.getTarget('guest-decoy-1');
        await waitFor(
          () => target.stats.wsClosedByClient >= 1 || target.stats.fullInjectCount >= 1,
          5000,
          30,
          'decoy probe settle'
        );
        await delay(150);
        assert.ok(target.stats.bindingsAdded.length === 0, `expected 0 bindings, got ${target.stats.bindingsAdded.length}`);
        assert.ok(target.stats.newDocScriptsAdded === 0, `expected 0 NewDocument, got ${target.stats.newDocScriptsAdded}`);
        assert.ok(target.stats.fullInjectCount === 0, `expected 0 inject(), got ${target.stats.fullInjectCount}`);
        assert.ok(target.stats.probeResults.includes('non_host'), 'expected probe result non_host');
        assert.ok(target.stats.wsClosedByClient >= 1 && target.sockets.size === 0, 'expected WS closed');
        assert.ok(target.vm.document.querySelector('#root button').textContent === 'Settings', 'button text must stay Settings');
        return 'rejected /main.js + #root + productName=my-app decoy, 0 injection';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'runtime.newdoc_null_document_element',
    async run(repoDir) {
      const script = loadRuntimeScriptWithBoot(repoDir);

      // Sub-case A: Antigravity host cold boot with documentElement === null
      const hostVm = createBrowserVm({
        url: 'https://127.0.0.1:54321/',
        readyState: 'loading',
        nullDocumentElement: true,
        electronNative: true,
        nativeStorage: true
      });
      try {
        try {
          hostVm.evaluate(script, 'core/runtime.js');
        } catch (err) {
          const stackLine = sanitizeText(String(err?.stack || '')).split('\n').slice(0, 2).join(' | ');
          throw new Error(`Host null documentElement threw ${err.name}: ${err.message} (${stackLine})`);
        }
        assert.ok(hostVm.getDclListenerCount() >= 1, 'expected DOMContentLoaded listener to be mounted when documentElement is null');
        assert.equal(hostVm.window.__ag_skip_non_host, undefined, 'host must not set __ag_skip_non_host during loading');

        hostVm.transitionToReady({
          readyState: 'interactive',
          hasJetboxCss: true,
          appConfig: { productName: 'antigravity' }
        });

        assert.notEqual(hostVm.document.getElementById('ag-custom-fonts'), null, 'host should inject #ag-custom-fonts after DOMContentLoaded');
        assert.equal(hostVm.document.documentElement.getAttribute('data-ag-wax-seal'), 'on', 'host should set data-ag-wax-seal');
        assert.equal(hostVm.window.__ag_skip_non_host, undefined, 'host must not set __ag_skip_non_host');
      } finally {
        hostVm.destroy();
      }

      // Sub-case B: Non-host guest with documentElement === null, readyState === 'loading' -> ready
      const guestVm = createBrowserVm({
        url: 'http://127.0.0.1:4173/',
        readyState: 'loading',
        nullDocumentElement: true
      });
      try {
        guestVm.evaluate(script, 'core/runtime.js');
        assert.ok(guestVm.getDclListenerCount() >= 1, 'expected DOMContentLoaded listener for null documentElement guest');
        assert.equal(guestVm.window.__ag_skip_non_host, undefined, 'must not mark __ag_skip_non_host while readyState is loading');

        guestVm.transitionToReady({
          readyState: 'interactive',
          hasRootDecoy: true
        });

        assert.equal(guestVm.window.__ag_skip_non_host, true, 'expected __ag_skip_non_host=true on non-host after DOMContentLoaded');
        assert.equal(guestVm.document.getElementById('ag-custom-fonts'), null, 'non-host must have 0 #ag-custom-fonts');
        assert.equal(guestVm.document.documentElement.getAttribute('data-ag-wax-seal'), null, 'non-host must have 0 data-ag-*');
        assert.equal(guestVm.document.querySelector('#root button').textContent, 'Settings', 'non-host text must remain untranslated');
      } finally {
        guestVm.destroy();
      }

      return '0 exceptions when documentElement=null; DCL deferred -> host injected, non-host marked __ag_skip_non_host=true';
    }
  },

  {
    id: 'guest.loading_then_domcontentloaded_non_host',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'guest-loading-1',
          type: 'page',
          title: 'Slow Local Page',
          url: 'http://127.0.0.1:4174/',
          vm: {
            url: 'http://127.0.0.1:4174/',
            readyState: 'loading',
            nullDocumentElement: true
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case4', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: false });
      try {
        const target = cdp.getTarget('guest-loading-1');
        // Wait for initial WS attach & first probe while still loading
        await waitFor(() => target.stats.wsConnections >= 1 && target.stats.methods.length >= 2, 5000, 20, 'initial WS attach');
        await delay(200);

        // During loading: must NOT settle as non_host or inject
        assert.ok(target.stats.evalExceptions.length === 0, `unexpected eval exception during loading: ${target.stats.evalExceptions[0]?.message}`);
        assert.ok(target.stats.fullInjectCount === 0, `must not inject during loading, got ${target.stats.fullInjectCount}`);
        assert.ok(target.stats.wsClosedByClient === 0, 'must not prematurely close WS or skip-cache while readyState is loading');
        assert.ok(target.stats.probeResults.includes('pending'), 'expected pending probe result while loading');

        // Now complete DOM without any host fingerprint and emit Page.domContentEventFired
        target.vm.transitionToReady({
          readyState: 'interactive',
          hasRootDecoy: true
        });
        target.sendEvent('Page.domContentEventFired', { timestamp: Date.now() / 1000 });

        await waitFor(() => target.stats.wsClosedByClient >= 1, 5000, 25, 'WS closed after domContentEventFired');
        await delay(200);

        assert.ok(target.stats.fullInjectCount === 0, `expected 0 inject() after DCL, got ${target.stats.fullInjectCount}`);
        assert.ok(target.stats.bindingsAdded.length === 0, `expected 0 bindings, got ${target.stats.bindingsAdded.length}`);
        assert.ok(target.stats.activeNewDocScripts.size === 0, 'expected 0 remaining NewDocument scripts');
        assert.ok(target.stats.probeResults.includes('non_host'), 'expected probe to settle as non_host after DCL');

        // Confirm next sync tick does not re-attach
        const listNow = cdp.getListRequestCount();
        await cdp.waitForListCount(listNow + 1, 5000);
        await delay(250);
        assert.ok(target.stats.wsConnections === 1, `expected no re-attach on next sync tick once settled as non_host (got ${target.stats.wsConnections})`);
        return 'pending while loading -> non_host after DCL -> NewDocument clear / WS closed / 0 inject';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'guest.heartbeat_zero_reattach',
    async run(repoDir) {
      const startedAt = Date.now();
      const cdp = createMockCdpServer([
        {
          id: 'guest-hb-1',
          type: 'page',
          title: 'Heartbeat Guest',
          url: 'http://127.0.0.1:4173/',
          vm: {
            url: 'http://127.0.0.1:4173/',
            readyState: 'complete',
            hasRootDecoy: true
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case5', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: false });
      try {
        const target = cdp.getTarget('guest-hb-1');
        // Wait for tick #1 (syncTickCount = 1)
        await cdp.waitForListCount(1, 5000);
        await waitFor(
          () => target.stats.wsClosedByClient >= 1 || target.stats.fullInjectCount >= 1,
          4000,
          25,
          'tick 1 settle'
        );
        const wsAfterTick1 = target.stats.wsConnections;
        assert.ok(target.stats.fullInjectCount === 0, `expected 0 inject on tick 1, got ${target.stats.fullInjectCount}`);
        assert.ok(target.stats.wsClosedByClient === 1, `expected WS closed on tick 1 after non_host skip, got ${target.stats.wsClosedByClient}`);
        assert.ok(wsAfterTick1 === 1, `expected exactly 1 probe WS on tick 1, got ${wsAfterTick1}`);

        // Wait through >= 7 sync ticks (includes tick 7 where syncTickCount % 6 === 1 heartbeat check)
        await cdp.waitForListCount(7, 25000);
        await delay(500);
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < 30000, `expected >= 7 ticks in < 30s, took ${elapsedMs}ms`);
        assert.ok(target.stats.wsConnections - wsAfterTick1 === 0, `expected 0 new WS connections across ticks 2..7, got ${target.stats.wsConnections - wsAfterTick1}`);
        assert.ok(target.stats.fullInjectCount === 0, `expected 0 total injections, got ${target.stats.fullInjectCount}`);
        assert.ok(!daemon.stdout.includes('[Daemon] Injected'), 'expected zero [Daemon] Injected logs');
        return `7 sync ticks in ${(elapsedMs / 1000).toFixed(1)}s (<30s): delta WS=0, inject=0`;
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'guest.same_tab_port_switch_and_external',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'tab-via-external',
          type: 'page',
          title: 'Tab A',
          url: 'http://127.0.0.1:4173/',
          vm: { url: 'http://127.0.0.1:4173/', readyState: 'complete', hasRootDecoy: true }
        },
        {
          id: 'tab-direct-switch',
          type: 'page',
          title: 'Tab B',
          url: 'http://127.0.0.1:4173/',
          vm: { url: 'http://127.0.0.1:4173/', readyState: 'complete', hasRootDecoy: true }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case6', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: false });
      try {
        const tabA = cdp.getTarget('tab-via-external');
        const tabB = cdp.getTarget('tab-direct-switch');

        // Tick 1: both tabs at 127.0.0.1:4173 -> probed & skipped
        await cdp.waitForListCount(1, 5000);
        await waitFor(
          () =>
            (tabA.stats.wsClosedByClient >= 1 || tabA.stats.fullInjectCount >= 1) &&
            (tabB.stats.wsClosedByClient >= 1 || tabB.stats.fullInjectCount >= 1),
          4000,
          25,
          'tick 1 settle both tabs'
        );
        assert.ok(tabA.stats.fullInjectCount === 0, `tabA tick 1 must have 0 inject (got ${tabA.stats.fullInjectCount})`);
        assert.ok(tabB.stats.fullInjectCount === 0, `tabB tick 1 must have 0 inject (got ${tabB.stats.fullInjectCount})`);
        assert.ok(tabA.stats.wsConnections === 1, `tabA should probe once on :4173 (got ${tabA.stats.wsConnections})`);
        assert.ok(tabB.stats.wsConnections === 1, `tabB should probe once on :4173 (got ${tabB.stats.wsConnections})`);

        // Navigate Tab A -> https://example.com/ (external); Tab B -> http://127.0.0.1:5173/ (direct port switch)
        tabA.navigate('https://example.com/', { readyState: 'complete', hasRootDecoy: true });
        tabB.navigate('http://127.0.0.1:5173/', { readyState: 'complete', hasRootDecoy: true });

        await cdp.waitForListCount(2, 5000);
        await waitFor(() => tabB.stats.wsClosedByClient >= 2 || tabB.stats.fullInjectCount >= 1, 4000, 25, 'tick 2 tabB re-probe');
        await delay(200);

        assert.ok(tabA.stats.wsConnections === 1, 'tabA on https://example.com/ must be ignored (0 new WS)');
        assert.ok(tabB.stats.wsConnections === 2, 'tabB switching :4173 -> :5173 must invalidate cache & re-probe');
        assert.ok(tabB.stats.wsClosedByClient === 2, 'tabB must close WS after re-probe on :5173');
        assert.ok(tabB.stats.fullInjectCount === 0, 'tabB must have 0 inject on :5173');

        // Navigate Tab A -> http://127.0.0.1:5173/ (return from external to new port); keep Tab B at :5173
        tabA.navigate('http://127.0.0.1:5173/', { readyState: 'complete', hasRootDecoy: true });

        await cdp.waitForListCount(3, 5000);
        await waitFor(() => tabA.stats.wsClosedByClient >= 2 || tabA.stats.fullInjectCount >= 1, 4000, 25, 'tick 3 tabA re-probe');
        await delay(200);

        assert.ok(tabA.stats.wsConnections === 2, 'tabA returning to :5173 must re-probe');
        assert.ok(tabA.stats.wsClosedByClient === 2, 'tabA must skip & close WS on :5173');
        assert.ok(tabA.stats.fullInjectCount === 0, 'tabA must have 0 inject across all navigations');
        assert.ok(tabB.stats.wsConnections === 2, 'tabB staying on :5173 must stay cached (0 new WS on tick 3)');
        assert.ok(
          tabA.stats.probeResults.filter((x) => x === 'non_host').length === 2 &&
            tabB.stats.probeResults.filter((x) => x === 'non_host').length === 2,
          'expected 2 non_host probe results on both tabs'
        );
        return 'via-external (:4173->example.com->:5173) & direct (:4173->:5173) re-probed & skipped cleanly, 0 inject';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'host.main_window_cold_boot_preserved',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'host-cold-boot-1',
          type: 'page',
          title: 'Antigravity',
          url: 'https://127.0.0.1:54321/',
          vm: {
            url: 'https://127.0.0.1:54321/',
            readyState: 'loading',
            nullDocumentElement: true,
            electronNative: true,
            nativeStorage: true
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case7', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: false });
      try {
        const target = cdp.getTarget('host-cold-boot-1');
        // Wait for initial attach + NewDocument registration + initial inject attempt while documentElement === null
        await waitFor(
          () => target.stats.newDocScriptsAdded >= 1 && target.stats.fullInjectCount >= 1,
          5000,
          25,
          'cold-boot host initial attach'
        );
        await delay(100);

        // Verify NewDocument script itself runs cleanly when documentElement === null (simulated preload cold-boot)
        const newDocSrc = Array.from(target.stats.activeNewDocScripts.values())[0];
        assert.ok(newDocSrc && newDocSrc.length > 5000, 'expected Page.addScriptToEvaluateOnNewDocument source');
        const probeVm = createBrowserVm({
          url: 'https://127.0.0.1:54321/',
          readyState: 'loading',
          nullDocumentElement: true,
          electronNative: true,
          nativeStorage: true
        });
        try {
          probeVm.evaluate(newDocSrc, 'core/runtime.js');
        } catch (err) {
          throw new Error(`NewDocument cold-boot threw ${err.name}: ${err.message}`);
        } finally {
          probeVm.destroy();
        }

        // Now complete DOM with __APP_CONFIG__ + /jetbox.css and fire DOMContentLoaded + Page.domContentEventFired
        target.vm.transitionToReady({
          readyState: 'interactive',
          hasJetboxCss: true,
          appConfig: { productName: 'antigravity' },
          setupBody: (doc, body) => {
            const box = doc.createElement('div');
            box.id = 'antigravity.agentSidePanelInputBox';
            body.appendChild(box);
          }
        });
        target.sendEvent('Page.domContentEventFired', { timestamp: Date.now() / 1000 });

        await waitFor(
          () =>
            target.vm.document.getElementById('ag-custom-fonts') !== null &&
            target.vm.document.documentElement?.getAttribute('data-ag-wax-seal') === 'on',
          4000,
          25,
          'post-DCL host injection'
        );

        assert.ok(
          target.stats.evalExceptions.length === 0,
          `expected 0 eval exceptions, got: ${target.stats.evalExceptions[0]?.message}`
        );
        assert.ok(target.stats.bindingsAdded.includes('__agRequestMetrics'), 'expected __agRequestMetrics binding');
        assert.ok(target.stats.bindingsAdded.includes('__agRequestHardReload'), 'expected __agRequestHardReload binding');
        assert.ok(target.stats.newDocScriptsAdded >= 1, 'expected Page.addScriptToEvaluateOnNewDocument');
        assert.ok(target.vm.document.getElementById('ag-custom-fonts') !== null, 'expected #ag-custom-fonts');
        assert.ok(target.vm.document.documentElement.getAttribute('data-ag-wax-seal') === 'on', 'expected data-ag-wax-seal=on');
        assert.ok(target.vm.document.documentElement.getAttribute('data-ag-preset') === 'high-contrast', 'expected data-ag-preset');
        assert.ok(['light', 'dark'].includes(target.vm.document.documentElement.getAttribute('data-ag-theme-mode')), 'expected data-ag-theme-mode');
        assert.ok(target.vm.window.__ag_skip_non_host === undefined, 'host must not set __ag_skip_non_host');
        return '0 exceptions on cold boot; bindings + NewDocument + #ag-custom-fonts + data-ag-* injected';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'host.dev_url_mode_preserved',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'host-dev-url-1',
          type: 'page',
          title: 'Antigravity Dev',
          url: 'http://localhost:3000/',
          vm: {
            url: 'http://localhost:3000/',
            readyState: 'complete',
            electronNative: true,
            nativeStorage: true
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case8', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: true });
      try {
        const res = await daemon.waitExit(8000);
        assert.equal(res.code, 0, `daemon --once exited with ${res.code}`);
        const target = cdp.getTarget('host-dev-url-1');
        assert.ok(target.stats.evalExceptions.length === 0, `unexpected exception: ${target.stats.evalExceptions[0]?.message}`);
        assert.ok(target.stats.bindingsAdded.includes('__agRequestMetrics'), 'expected __agRequestMetrics binding');
        assert.ok(target.stats.bindingsAdded.includes('__agRequestHardReload'), 'expected __agRequestHardReload binding');
        assert.ok(target.stats.newDocScriptsAdded >= 1, 'expected NewDocument');
        assert.ok(target.stats.fullInjectCount >= 1, 'expected inject()');
        assert.notEqual(target.vm.document.getElementById('ag-custom-fonts'), null, 'expected #ag-custom-fonts');
        assert.equal(target.vm.document.documentElement.getAttribute('data-ag-wax-seal'), 'on', 'expected data-ag-wax-seal=on');
        return 'DEV_URL with electronNative+nativeStorage recognized as host, bindings + theme injected';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'host.swarm_iframe_preserved',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'host-swarm-iframe-1',
          type: 'iframe',
          title: 'Swarm Monitor',
          url: 'plugin://swarm--deadbeef/panel',
          vm: {
            url: 'plugin://swarm--deadbeef/panel',
            readyState: 'complete',
            isTopWindow: false,
            setupBody: (doc, body) => {
              const panel = doc.createElement('div');
              panel.id = 'swarm-panel';
              const s1 = doc.createElement('span');
              s1.id = 'lbl-coord';
              s1.textContent = 'Coordinator';
              const s2 = doc.createElement('span');
              s2.id = 'lbl-stuck';
              s2.textContent = 'Stuck';
              const msgBody = doc.createElement('div');
              msgBody.setAttribute('class', 'msg-body');
              msgBody.textContent = 'Coordinator';
              panel.appendChild(s1);
              panel.appendChild(s2);
              panel.appendChild(msgBody);
              body.appendChild(panel);
            }
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case9', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: true });
      try {
        const res = await daemon.waitExit(8000);
        assert.equal(res.code, 0, `daemon --once exited with ${res.code}`);
        const target = cdp.getTarget('host-swarm-iframe-1');
        assert.ok(target.vm.window.top !== target.vm.window, 'swarm iframe must satisfy window.top !== window');
        assert.ok(target.stats.evalExceptions.length === 0, `unexpected exception: ${target.stats.evalExceptions[0]?.message}`);
        assert.ok(target.stats.bindingsAdded.includes('__agRequestMetrics'), 'expected __agRequestMetrics binding');
        assert.ok(target.stats.newDocScriptsAdded >= 1, 'expected NewDocument');
        assert.notEqual(target.vm.document.getElementById('ag-custom-fonts'), null, 'expected #ag-custom-fonts');
        assert.equal(target.vm.document.documentElement.getAttribute('data-ag-page-type'), 'plugin', 'expected data-ag-page-type=plugin');
        assert.equal(target.vm.document.getElementById('lbl-coord').textContent, '协调器', 'expected SWARM_FRAME_ONLY_DICT Coordinator -> 协调器');
        assert.equal(target.vm.document.getElementById('lbl-stuck').textContent, '受阻停滞', 'expected SWARM_FRAME_ONLY_DICT Stuck -> 受阻停滞');
        assert.equal(target.vm.document.querySelector('.msg-body').textContent, 'Coordinator', '.msg-body must stay excluded from i18n');
        return 'plugin://swarm--* iframe exempted, #ag-custom-fonts & SWARM_FRAME_ONLY_DICT applied';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'host.vscode_file_preserved',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'host-vscode-file-1',
          type: 'page',
          title: 'Workbench',
          url: 'vscode-file://vscode-app/workbench.html',
          vm: {
            url: 'vscode-file://vscode-app/workbench.html',
            readyState: 'complete'
          }
        }
      ]);
      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case10', port);
      const daemon = startDaemonProcess(repoDir, sandbox, { once: true });
      try {
        const res = await daemon.waitExit(8000);
        assert.equal(res.code, 0, `daemon --once exited with ${res.code}`);
        const target = cdp.getTarget('host-vscode-file-1');
        assert.ok(target.stats.evalExceptions.length === 0, `unexpected exception: ${target.stats.evalExceptions[0]?.message}`);
        assert.ok(target.stats.bindingsAdded.includes('__agRequestMetrics'), 'expected __agRequestMetrics binding');
        assert.ok(target.stats.bindingsAdded.includes('__agRequestHardReload'), 'expected __agRequestHardReload binding');
        assert.ok(target.stats.newDocScriptsAdded >= 1, 'expected NewDocument');
        assert.notEqual(target.vm.document.getElementById('ag-custom-fonts'), null, 'expected #ag-custom-fonts');
        assert.equal(target.vm.document.documentElement.getAttribute('data-ag-wax-seal'), 'on', 'expected data-ag-wax-seal=on');
        return 'vscode-file:// exempted & injected normally';
      } finally {
        await daemon.stop();
        await cdp.close();
      }
    }
  },

  {
    id: 'cli.verify_picks_host_over_guest',
    async run(repoDir) {
      const cdp = createMockCdpServer([
        {
          id: 'target-guest-0',
          type: 'page',
          title: 'Local Dev Guest',
          url: 'http://127.0.0.1:4173/',
          vm: {
            url: 'http://127.0.0.1:4173/',
            readyState: 'complete',
            hasRootDecoy: true
          }
        },
        {
          id: 'target-host-1',
          type: 'page',
          title: 'Antigravity',
          url: 'https://127.0.0.1:54321/',
          vm: {
            url: 'https://127.0.0.1:54321/',
            readyState: 'complete',
            electronNative: true,
            nativeStorage: true,
            hasJetboxCss: true,
            appConfig: { productName: 'antigravity' },
            setupBody: (doc, body, head, html) => {
              const style = doc.createElement('style');
              style.id = 'ag-custom-fonts';
              style.textContent = '/* pre-injected host */';
              head.appendChild(style);
              html.setAttribute('data-ag-preset', 'high-contrast');
              html.setAttribute('data-ag-theme-mode', 'light');
              html.setAttribute('data-ag-page-type', 'chat');
              html.setAttribute('data-ag-wax-seal', 'on');
              const box = doc.createElement('div');
              box.id = 'antigravity.agentSidePanelInputBox';
              body.appendChild(box);
            }
          }
        }
      ]);
      const hostTarget = cdp.getTarget('target-host-1');
      hostTarget.vm.window.__ag_patch_version = '20261115-v5.3.0-stable-mock';
      hostTarget.vm.window.__ag_body_ready = true;
      hostTarget.vm.window.__ag_i18n_dict = Object.assign(Object.create(null), { Settings: '系统设置' });

      const port = await cdp.start();
      const sandbox = createIsolatedEnv('case11', port);
      try {
        // 1. Check doctor first against un-injected guest[0] vs injected host[1]
        const docRes = await runInstallCli(repoDir, 'doctor', sandbox);
        assert.equal(docRes.status, 0, `doctor failed (exit ${docRes.status}): ${docRes.sanitizedStderr}`);
        const docJson = extractTrailingJson(docRes.stdout);

        // 2. Run install.mjs verify (which spawns daemon.mjs --once then calls inspectLiveWindow)
        const verRes = await runInstallCli(repoDir, 'verify', sandbox);
        assert.equal(verRes.status, 0, `verify failed (exit ${verRes.status}): ${verRes.sanitizedStderr}`);
        const verJson = extractTrailingJson(verRes.stdout);
        const guestTarget = cdp.getTarget('target-guest-0');

        const problems = [];
        if (docJson?.liveWindow?.targetId !== 'target-host-1' || docJson?.liveWindow?.state?.hasStyle !== true) {
          problems.push(
            `doctor picked target=${docJson?.liveWindow?.targetId} (hasStyle=${docJson?.liveWindow?.state?.hasStyle}) instead of target-host-1`
          );
        }
        if (verJson?.live?.targetId !== 'target-host-1') {
          problems.push(
            `verify picked target=${verJson?.live?.targetId} (ok=${verJson?.ok}, themeStyle=${verJson?.themeStyle}) instead of target-host-1`
          );
        }
        if (verJson?.ok !== true || verJson?.themeStyle !== true) {
          problems.push(`verify returned ok=${verJson?.ok}, themeStyle=${verJson?.themeStyle}`);
        }
        if (guestTarget.stats.fullInjectCount !== 0 || guestTarget.vm.document.getElementById('ag-custom-fonts') !== null) {
          problems.push(`verify daemon --once polluted pages[0] guest (fullInjectCount=${guestTarget.stats.fullInjectCount})`);
        }
        assert.ok(problems.length === 0, problems.join(' | '));
        return `doctor & verify skipped pages[0] guest -> selected pages[1] host (ok=true, themeStyle=true)`;
      } finally {
        await cdp.close();
      }
    }
  }
];

async function main() {
  if (!fs.existsSync(path.join(REPO_DIR, 'core', 'daemon.mjs'))) {
    console.error(`ERROR: Target repo missing core/daemon.mjs: ${displayRepoLabel(REPO_DIR)}`);
    process.exit(2);
  }

  const selected = ONLY_CASE ? TEST_CASES.filter((c) => c.id === ONLY_CASE) : TEST_CASES;
  if (selected.length === 0) {
    console.error(`ERROR: Unknown case id: ${ONLY_CASE}`);
    process.exit(2);
  }

  console.log(`Mock CDP Host Gate Suite | repo=${displayRepoLabel(REPO_DIR)} | node=${process.version} | cases=${selected.length}`);

  let passed = 0;
  let failed = 0;

  try {
    for (const tc of selected) {
      const t0 = Date.now();
      try {
        const detail = await tc.run(REPO_DIR);
        const ms = Date.now() - t0;
        passed += 1;
        console.log(`PASS [${tc.id}] (${ms}ms) ${sanitizeText(detail)}`);
      } catch (err) {
        const ms = Date.now() - t0;
        failed += 1;
        const msg = sanitizeText(err?.message || String(err));
        console.log(`FAIL [${tc.id}] (${ms}ms) ${msg}`);
      }
    }
  } finally {
    try {
      fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true });
    } catch {}
  }

  console.log(`SUMMARY: ${passed}/${selected.length} PASS, ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
