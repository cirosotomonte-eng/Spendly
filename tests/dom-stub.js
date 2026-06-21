// ── Minimal fake DOM ────────────────────────────────────────────────────────
// Goal: let inline render functions (updateHeader, renderDashboard, renderAccounts,
// etc.) run to completion without throwing, so we catch ReferenceErrors / TypeErrors
// from undefined variables or null DOM nodes — the exact bug class that slipped
// through before. We are NOT trying to render real pixels, just survive execution
// and capture text/values that got assigned.

function makeFakeElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    _children: [],
    style: {
      setProperty(name, value) { this[name] = value; },
      getPropertyValue(name) { return this[name] || ''; },
      removeProperty(name) { delete this[name]; },
    },
    classList: {
      add() {}, remove() {}, contains() { return false; }, toggle() {},
    },
    dataset: {},
    attributes: {},
    disabled: false,
    value: '',
    checked: false,
    _innerHTML: '',
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) { this._innerHTML = v; },
    get textContent() { return this._textContent || ''; },
    set textContent(v) { this._textContent = v; },
    appendChild(child) { this._children.push(child); return child; },
    removeChild(child) { this._children = this._children.filter(c => c !== child); },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    querySelector() { return makeFakeElement('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    blur() {},
    click() {},
    get firstChild() { return this._children[0] || null; },
    get previousElementSibling() { return makeFakeElement('div'); },
    cloneNode() { return makeFakeElement(tag); },
    scrollIntoView() {},
    contains() { return false; },
  };
  return el;
}

function makeFakeDocument() {
  const elementsById = {};
  const doc = {
    _elementsById: elementsById,
    getElementById(id) {
      if (!elementsById[id]) elementsById[id] = makeFakeElement('div');
      return elementsById[id];
    },
    createElement(tag) { return makeFakeElement(tag); },
    querySelector() { return makeFakeElement('div'); },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
    body: makeFakeElement('body'),
    documentElement: makeFakeElement('html'),
    createTextNode(t) { return { textContent: t }; },
    hidden: false,
  };
  doc.body.appendChild = () => {};
  doc.body.prepend = () => {};
  return doc;
}

function makeFakeStorage() {
  const store = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    clear() { Object.keys(store).forEach(k => delete store[k]); },
    get _store() { return store; },
  };
}

module.exports = { makeFakeElement, makeFakeDocument, makeFakeStorage };
