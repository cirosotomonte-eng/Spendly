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
    Blob: class FakeBlob { constructor() {} },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    fetch: () => Promise.reject(new Error('network disabled in test harness')),
    Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    addEventListener() {}, removeEventListener() {},
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

  return context;
}

module.exports = { loadApp, extractInlineScripts };
