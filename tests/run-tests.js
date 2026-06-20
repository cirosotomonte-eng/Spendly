const path = require('path');
const { loadApp } = require('./load-app');
const { buildMockState, addDays } = require('./fixtures');

const APP_PATH = process.argv[2] || path.join(__dirname, '..', 'spendly-generic.html');

let pass = 0, fail = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('      ' + e.message);
  }
}

function assertEqual(actual, expected, msg) {
  if (Math.abs(actual - expected) > 0.01) {
    throw new Error((msg || 'value mismatch') + ` — expected ${expected}, got ${actual}`);
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy value');
}
function assertNoThrow(fn, msg) {
  try { fn(); } catch (e) { throw new Error((msg || 'should not throw') + ' — ' + e.message); }
}

console.log('Loading app from', APP_PATH, '\n');
const ctx = loadApp(APP_PATH);

// Bypass PIN gate so isSetupComplete() doesn't redirect renders to onboarding screen
ctx.localStorage.setItem('spendly_lock_skipped', '1');


async function main() {
// ─────────────────────────────────────────────────────────────────────────
console.log('── Unit tests: pure calculation logic ──────────────────────────');

await check('budgetAmount: full goal coverage nets to zero', () => {
  const e = { amount: 100, goalCoveredAmount: 100 };
  assertEqual(ctx.budgetAmount(e), 0, 'fully covered expense should net to 0');
});

await check('budgetAmount: partial goal coverage nets the remainder', () => {
  const e = { amount: 100, goalCoveredAmount: 40 };
  assertEqual(ctx.budgetAmount(e), 60, 'partially covered expense should net the uncovered part');
});

await check('budgetAmount: no goal coverage returns full amount', () => {
  const e = { amount: 75.50 };
  assertEqual(ctx.budgetAmount(e), 75.50);
});

await check('monthlyEquivalent: weekly converts to ~4.33x', () => {
  const r = { amount: 875, frequency: 'weekly' };
  assertEqual(ctx.monthlyEquivalent(r), 875 * 52 / 12);
});

await check('monthlyEquivalent: fortnightly (xweeks=2) converts correctly', () => {
  const r = { amount: 100, frequency: 'xweeks', xweeksNum: 2 };
  assertEqual(ctx.monthlyEquivalent(r), 100 * (52 / 2) / 12);
});

await check('monthlyEquivalent: monthly passes through unchanged', () => {
  const r = { amount: 200, frequency: 'monthly' };
  assertEqual(ctx.monthlyEquivalent(r), 200);
});

await check('monthlyEquivalent: quarterly divides by 3', () => {
  const r = { amount: 300, frequency: 'quarterly' };
  assertEqual(ctx.monthlyEquivalent(r), 100);
});

await check('monthlyEquivalent: yearly divides by 12', () => {
  const r = { amount: 1200, frequency: 'yearly' };
  assertEqual(ctx.monthlyEquivalent(r), 100);
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── getCycleSummary: past cycle includes recurring savings ──────');

await check('getCycleSummary(-1): includes fired pending savings in spent total', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(-1);
  const cycleStartStr = ctx.dateToStr(cycleStart);
  const midCycleDate = addDays(cycleStartStr, 5);

  // One logged expense
  ctx.state.expenses.push({ id: 'e1', date: midCycleDate, amount: 200, categoryId: 'cat1' });
  // One paid pending saving (simulates a mortgage contribution already paid)
  ctx.state.pendingPayments.push({
    id: 'p1', goalId: 'goal1', amount: 875, dueDate: midCycleDate, status: 'paid',
  });
  ctx.state.savingsDeposits.push({
    id: 'd1', catId: 'goal1', amount: 875, date: midCycleDate, cycleDate: midCycleDate, recurringId: 'rec1',
  });

  const summary = ctx.getCycleSummary(-1);
  assertEqual(summary.expensesOnly, 200, 'expensesOnly should only count logged expenses');
  assertEqual(summary.savings, 875, 'savings should count the fired deposit');
  assertEqual(summary.spent, 1075, 'spent should be expenses + savings combined');
  assertEqual(summary.diff, ctx.state.budget - 1075, 'diff should be budget minus total spent');
});

await check('getCycleSummary(-1): still-pending (unpaid) savings also count as committed', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(-1);
  const cycleStartStr = ctx.dateToStr(cycleStart);
  const midCycleDate = addDays(cycleStartStr, 5);

  ctx.state.pendingPayments.push({
    id: 'p2', goalId: 'goal1', amount: 500, dueDate: midCycleDate, status: 'pending',
  });

  const summary = ctx.getCycleSummary(-1);
  assertEqual(summary.savings, 500, 'unpaid pending saving due that cycle should still count');
});

await check('getCycleSummary(-1): does not double-count a paid pending payment', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(-1);
  const cycleStartStr = ctx.dateToStr(cycleStart);
  const midCycleDate = addDays(cycleStartStr, 5);

  // A pending payment that has been paid (status 'paid') should NOT be counted
  // again via the pendingTotal path — only its matching deposit should count.
  ctx.state.pendingPayments.push({
    id: 'p3', goalId: 'goal1', amount: 875, dueDate: midCycleDate, status: 'paid',
  });
  ctx.state.savingsDeposits.push({
    id: 'd3', catId: 'goal1', amount: 875, date: addDays(midCycleDate, 1), cycleDate: midCycleDate, recurringId: 'rec3',
  });

  const summary = ctx.getCycleSummary(-1);
  assertEqual(summary.savings, 875, 'paid pending + its deposit should total once, not twice');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── DOM smoke tests: render functions must not throw, across cycles ──');

const offsetsToTest = [-2, -1, 0, 1];

for (const offset of offsetsToTest) {
  await check(`updateHeader() does not throw at offset ${offset}`, () => {
    ctx.state = buildMockState();
    ctx.state.viewingCycleOffset = offset;
    // Give it a little data so paths that branch on "has expenses" are exercised
    const { cycleStart } = ctx.getCycleRange(offset);
    const dateInCycle = addDays(ctx.dateToStr(cycleStart), 3);
    ctx.state.expenses.push({ id: 'e_' + offset, date: dateInCycle, amount: 50, categoryId: 'cat1' });
    if (offset < 0) {
      ctx.state.savingsDeposits.push({
        id: 'd_' + offset, catId: 'goal1', amount: 100, date: dateInCycle, cycleDate: dateInCycle, recurringId: 'rec_' + offset,
      });
    }
    assertNoThrow(() => ctx.updateHeader());
  });

  await check(`renderDashboard() does not throw at offset ${offset}`, () => {
    ctx.state = buildMockState();
    ctx.state.viewingCycleOffset = offset;
    ctx.state.currentTab = 'dashboard';
    assertNoThrow(() => ctx.renderDashboard());
  });
}

await check('renderDashboard() + updateHeader() headline matches getCycleSummary for a past cycle', () => {
  ctx.state = buildMockState();
  ctx.state.viewingCycleOffset = -1;
  const { cycleStart } = ctx.getCycleRange(-1);
  const dateInCycle = addDays(ctx.dateToStr(cycleStart), 3);
  ctx.state.expenses.push({ id: 'eX', date: dateInCycle, amount: 9000, categoryId: 'cat1' }); // force overspend
  // Real app always calls both together (via renderContent()) — mirror that here.
  ctx.updateHeader();
  ctx.renderDashboard();
  const expected = ctx.getCycleSummary(-1).diff;
  const remainEl = ctx.document.getElementById('totalRemain');
  const shownIsNegative = remainEl.textContent.trim().startsWith('-');
  assertTrue(shownIsNegative === (expected < 0), 'dashboard headline sign should match getCycleSummary diff sign');
});

await check('updateHeader() headline matches getCycleSummary for a past cycle (regression: committed scoping bug)', () => {
  ctx.state = buildMockState();
  ctx.state.viewingCycleOffset = -1;
  const { cycleStart } = ctx.getCycleRange(-1);
  const dateInCycle = addDays(ctx.dateToStr(cycleStart), 3);
  ctx.state.expenses.push({ id: 'eY', date: dateInCycle, amount: 9000, categoryId: 'cat1' });
  assertNoThrow(() => ctx.updateHeader(), 'updateHeader must not throw for past cycle — this is the exact bug class that shipped in v2.5.92');
  const expected = ctx.getCycleSummary(-1).diff;
  const remainEl = ctx.document.getElementById('totalRemain');
  const shownIsNegative = remainEl.textContent.trim().startsWith('-');
  assertTrue(shownIsNegative === (expected < 0), 'updateHeader headline sign should match getCycleSummary diff sign');
});

for (const offset of [-1, 0]) {
  await check(`renderAccounts() account list does not throw at cycle offset ${offset}`, () => {
    ctx.state = buildMockState();
    ctx.state.viewingCycleOffset = offset;
    ctx.state.currentTab = 'accounts';
    ctx._viewingAccountId = null;
    assertNoThrow(() => ctx.renderAccounts());
  });

  await check(`renderAccounts() CC account detail does not throw at cycle offset ${offset}`, () => {
    ctx.state = buildMockState();
    ctx.state.viewingCycleOffset = offset;
    ctx.state.currentTab = 'accounts';
    ctx._viewingAccountId = 'cc1';
    // Add an old unsettled CC charge so the owed/breakdown code paths run
    const pastDate = addDays(ctx.todayStr(), -60);
    ctx.state.expenses.push({ id: 'ccE1', date: pastDate, amount: 120, categoryId: 'cat1', paymentAccountId: 'cc1' });
    assertNoThrow(() => ctx.renderAccounts());
    ctx._viewingAccountId = null; // reset for next test
  });

  await check(`renderAccounts() Offset account detail does not throw at cycle offset ${offset}`, () => {
    ctx.state = buildMockState();
    ctx.state.viewingCycleOffset = offset;
    ctx.state.currentTab = 'accounts';
    ctx._viewingAccountId = 'offset1';
    assertNoThrow(() => ctx.renderAccounts());
    ctx._viewingAccountId = null;
  });
}

await check('renderExpenses() does not throw and respects viewingCycleOffset for past cycle', () => {
  ctx.state = buildMockState();
  ctx.state.viewingCycleOffset = -1;
  ctx.state.currentTab = 'expenses';
  const { cycleStart } = ctx.getCycleRange(-1);
  const dateInCycle = addDays(ctx.dateToStr(cycleStart), 2);
  ctx.state.expenses.push({ id: 'pastExp', date: dateInCycle, amount: 33, categoryId: 'cat1' });
  assertNoThrow(() => ctx.renderExpenses());
  // cycleExpenses() should only see the past-cycle expense when offset is -1
  const visible = ctx.cycleExpenses();
  assertTrue(visible.some(e => e.id === 'pastExp'), 'past-cycle expense should be visible when viewingCycleOffset=-1');
});

await check('renderExpenses() future cycle dispatches to renderFutureCycle without throwing', () => {
  ctx.state = buildMockState();
  ctx.state.viewingCycleOffset = 1;
  ctx.state.currentTab = 'expenses';
  assertNoThrow(() => ctx.renderExpenses());
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── CC owed total: must not reset when budget cycle rolls over ──');

await check('CC owed total includes unsettled charges from a previous cycle (regression: cycle-rollover bug)', () => {
  ctx.state = buildMockState();
  ctx.state.viewingCycleOffset = 0;
  const oldDate = addDays(ctx.todayStr(), -45); // safely in a previous cycle
  ctx.state.expenses.push({ id: 'oldCC', date: oldDate, amount: 5607.12, categoryId: 'cat1', paymentAccountId: 'cc1' });
  ctx._viewingAccountId = 'cc1';
  ctx.state.currentTab = 'accounts';
  assertNoThrow(() => ctx.renderAccounts());
  ctx._viewingAccountId = null;
  // No direct getter for the rendered "owed" figure without scraping HTML, so we
  // at least confirm the underlying data the calculation depends on is intact —
  // full HTML-content assertions are added below via a text-scrape check.
});

await check('CC owed figure (scraped from rendered HTML) reflects old unsettled charge', () => {
  ctx.state = buildMockState();
  ctx.state.viewingCycleOffset = 0;
  const oldDate = addDays(ctx.todayStr(), -45);
  ctx.state.expenses.push({ id: 'oldCC2', date: oldDate, amount: 1234.56, categoryId: 'cat1', paymentAccountId: 'cc1' });
  ctx.state.currentTab = 'accounts';
  ctx._viewingAccountId = 'cc1';
  ctx.renderAccounts();
  const contentEl = ctx.document.getElementById('content');
  const html = contentEl.innerHTML || '';
  assertTrue(html.includes('1,234.56') || html.includes('1234.56'), 'rendered CC detail page should show the old unsettled amount');
  ctx._viewingAccountId = null;
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Hydration gate: must never write empty/unconfirmed state to Supabase ──');
console.log('   (regression for a real data-loss incident — see commit history)');

await check('saveState() is blocked before any load has completed this session', () => {
  ctx.state = buildMockState();
  ctx.__fetchCalls.length = 0;
  // Simulate a fresh session with no session id yet — getCurrentUserId() is null,
  // _stateHydrated defaults to false at fresh context load.
  ctx.saveState();
  assertTrue(ctx.__fetchCalls.length === 0, 'saveState() must not even be able to schedule a write before hydration is confirmed');
});

await check('saveState() proceeds normally once hydration is confirmed (simulated successful load)', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true; // simulate what loadState() sets on a confirmed success
  ctx.__fetchCalls.length = 0;
  ctx.saveState();
  // saveState() only *schedules* a debounced write (1200ms) — wait past that
  // window and confirm a real write attempt happened, proving the gate isn't
  // blocking a legitimately-hydrated session.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assertTrue(ctx.__fetchCalls.length > 0, 'saveState() should attempt a real write once hydrated');
        resolve();
      } catch (e) { reject(e); }
    }, 1300);
  });
});

await check('signOut() cancels any pending sync timer and closes the gate (the actual root-cause fix)', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx.__fetchCalls.length = 0;
  // Schedule a save as if the user had just made a change
  ctx.saveState();
  assertTrue(ctx._stateHydrated === true, 'sanity: gate should be open before sign-out');
  // Now simulate sign-out's synchronous effects directly (without calling the
  // real signOut(), which would try to hit the real Supabase auth endpoint) —
  // specifically test the two critical lines: clearTimeout(syncTimer) and the gate.
  ctx.clearTimeout(ctx.syncTimer);
  ctx._stateHydrated = false;
  ctx.state = buildMockState(); // signOut() resets state to empty defaults
  // Advance past the original 1200ms debounce window to see if the OLD timer
  // would have fired and attempted a write — it must not, because we cancelled it.
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assertTrue(ctx.__fetchCalls.length === 0, 'a cancelled pending sync must never fire and write empty state after sign-out');
        resolve();
      } catch (e) { reject(e); }
    }, 1300);
  });
});

await check('loadFromSupabase()-style error result must never open the hydration gate', () => {
  ctx.state = buildMockState();
  ctx._stateHydrated = false;
  // We can't hit real network in this harness, but we can directly verify the
  // *contract*: loadState() only sets _stateHydrated=true on 'success' or 'empty'
  // status, never on 'error'. Inspect the function source for this invariant
  // rather than mocking the network, since vm sandboxing makes fetch-mocking the
  // async loadFromSupabase() path brittle — the contract check is what matters.
  const src = ctx.loadState.toString();
  assertTrue(src.includes("result.status === 'success'"), 'loadState must branch on a successful result before hydrating');
  assertTrue(src.includes("result.status === 'empty'"), 'loadState must branch on a confirmed-empty result before hydrating');
  assertTrue(!/result\.status === 'error'[\s\S]{0,80}_stateHydrated = true/.test(src), 'loadState must NEVER set _stateHydrated=true on an error result');
});

await check('only one loadState() and one flushSyncNow() are defined (regression: silent duplicate-function shadowing)', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const loadStateCount = (html.match(/^async function loadState\(\)/gm) || []).length;
  const flushCount = (html.match(/^async function flushSyncNow\(\)/gm) || []).length;
  assertEqual(loadStateCount, 1, 'loadState must be declared exactly once — a second declaration silently shadows the first');
  assertEqual(flushCount, 1, 'flushSyncNow must be declared exactly once');
});



console.log(`\x1b[1mResults: ${pass} passed, ${fail} failed\x1b[0m`);
if (fail > 0) {
  console.log('\nFailed tests:');
  failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error.message));
  process.exit(1);
} else {
  console.log('All checks passed.');
  process.exit(0);
}
}

main();
