const fs = require('fs');
const vm = require('vm');
const { makeFakeDocument, makeFakeStorage, makeFakeElement } = require('./dom-stub');

function extractInlineScripts(html) {
  // Match <script ...> ... </script>, skip any tag that has a src= attribute
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  const blocks = [];
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue; // external script (CDN) — skip
    blocks.push(m[2]);
  }
  return blocks.join('\n;\n');
}

function loadApp(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  let scriptSrc = extractInlineScripts(html);

  // CRITICAL: top-level `let`/`const` bindings created by vm.runInContext do NOT
  // sync with property assignment on the sandbox object from outside (ctx.state = x
  // silently creates an unrelated property; the app's functions keep using the
  // original binding). We append accessor functions that run INSIDE the context,
  // so external code can reliably get/set the real `state` the app functions use.
  scriptSrc += '\n;function __setState(s) { state = s; }\n;function __getState() { return state; }\n';
  scriptSrc += '\n;function __setHydrated(v) { _stateHydrated = v; }\n;function __getHydrated() { return _stateHydrated; }\n';
  scriptSrc += '\n;function __setSession(s) { _sbSession = s; }\n;function __getSession() { return _sbSession; }\n';
  scriptSrc += '\n;function __setFailures(v) { _consecutiveSyncFailures = v; }\n;function __getFailures() { return _consecutiveSyncFailures; }\n';

  const fakeDocument = makeFakeDocument();
  fakeDocument.readyState = 'loading'; // prevents auto-boot (init) from firing
  fakeDocument.head = makeFakeElement('head');
  fakeDocument.head.appendChild = () => {};

  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => { try { cb(); } catch (e) { /* swallow for harness */ } return 0; },
    document: fakeDocument,
    localStorage: makeFakeStorage(),
    sessionStorage: makeFakeStorage(),
    navigator: {},
    Blob: globalThis.Blob,
    File: globalThis.File,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    fetch: (...args) => { sandbox.__fetchCalls.push(args); return Promise.reject(new Error('network disabled in test harness')); },
    __fetchCalls: [],
    Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    addEventListener() {}, removeEventListener() {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  };
  sandbox.window = sandbox; // classic-script global aliasing

  const context = vm.createContext(sandbox);
  try {
    vm.runInContext(scriptSrc, context, { filename: htmlPath, timeout: 10000 });
  } catch (e) {
    console.error('Failed to load app script into vm context:', e.message);
    throw e;
  }

  // Make ctx.state transparently proxy to the real internal `let state` binding,
  // so test code can write `ctx.state = {...}` and `ctx.state.expenses.push(...)`
  // naturally and have it actually affect what the app's functions see.
  Object.defineProperty(context, 'state', {
    get() { return context.__getState(); },
    set(v) { context.__setState(v); },
    configurable: true,
  });
  Object.defineProperty(context, '_stateHydrated', {
    get() { return context.__getHydrated(); },
    set(v) { context.__setHydrated(v); },
    configurable: true,
  });
  Object.defineProperty(context, '_sbSession', {
    get() { return context.__getSession(); },
    set(v) { context.__setSession(v); },
    configurable: true,
  });
  Object.defineProperty(context, '_consecutiveSyncFailures', {
    get() { return context.__getFailures(); },
    set(v) { context.__setFailures(v); },
    configurable: true,
  });

  return context;
}

module.exports = { loadApp, extractInlineScripts };
