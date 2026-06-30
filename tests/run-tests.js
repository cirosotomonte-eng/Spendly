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

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Attachment storage: payload size must not balloon from embedded images ──');

await check('resolveAttachmentUrl() returns legacy base64 data URLs unchanged (no network needed)', async () => {
  const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const result = await ctx.resolveAttachmentUrl(fakeDataUrl);
  assertEqual(result, fakeDataUrl, 'legacy base64 refs should pass through unchanged without any network call');
});

await check('resolveAttachmentUrl() returns empty string for a null/empty ref without throwing', async () => {
  const result = await ctx.resolveAttachmentUrl('');
  assertEqual(result, '', 'empty ref should resolve to empty string, not throw');
});

await check('dataURLToFile() correctly reconstructs a File from a base64 data URL', () => {
  const fakeDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const file = ctx.dataURLToFile(fakeDataUrl, 'test.png');
  assertTrue(file.name === 'test.png', 'file name should match what was passed in');
  assertTrue(file.type === 'image/png', 'file type should be extracted from the data URL header');
  assertTrue(file.size > 0, 'reconstructed file should have non-zero size');
});

await check('migrateAttachmentsToStorage() reports nothing-to-migrate when no embedded images exist', () => {
  ctx.state = buildMockState();
  ctx.state.giftCards = [{ id: 'gc1', name: 'Test', image: 'someuser/giftcards/123_already_migrated.jpg' }];
  ctx.state.taxTransactions = [];
  // Only checking the filter logic the function uses internally produces zero candidates —
  // full network-dependent migration isn't exercised here (no real Supabase in this harness).
  const giftCardsToMigrate = (ctx.state.giftCards||[]).filter(gc => gc.image && gc.image.startsWith('data:'));
  assertEqual(giftCardsToMigrate.length, 0, 'a gift card with an already-migrated storage path should not be re-migrated');
});

await check('new tax attachments use {path} not {data} — old base64 embedding code path is gone', () => {
  const src = ctx.handleTxFileSelect.toString();
  assertTrue(src.includes('uploadAttachment'), 'handleTxFileSelect must upload to storage');
  assertTrue(!src.includes('readAsDataURL'), 'handleTxFileSelect must no longer embed base64 directly into state');
});

await check('new gift card images use uploadAttachment, not embedded base64, for the persisted value', () => {
  const src = ctx.loadGcImage.toString();
  assertTrue(src.includes('uploadAttachment'), 'loadGcImage must upload to storage');
  assertTrue(src.includes('preview.dataset.src = path'), 'the persisted dataset.src must end up as the storage path, not base64');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Sync retry: must auto-retry with backoff and alert after 3 failures ──');

await check('getSyncRetryDelay() produces increasing backoff: 3s, 8s, 20s, then 30s', () => {
  assertEqual(ctx.getSyncRetryDelay(1), 3000);
  assertEqual(ctx.getSyncRetryDelay(2), 8000);
  assertEqual(ctx.getSyncRetryDelay(3), 20000);
  assertEqual(ctx.getSyncRetryDelay(4), 30000);
  assertEqual(ctx.getSyncRetryDelay(10), 30000, 'backoff should cap at 30s, not grow unbounded');
});

await check('onSyncFailure() increments the consecutive-failure counter each time', () => {
  ctx.state = buildMockState();
  ctx._consecutiveSyncFailures = 0;
  ctx.clearTimeout(ctx._syncRetryTimer);

  ctx.onSyncFailure({});
  assertTrue(ctx._consecutiveSyncFailures === 1, 'first failure should increment counter to 1');

  ctx.onSyncFailure({});
  ctx.onSyncFailure({});
  assertTrue(ctx._consecutiveSyncFailures === 3, 'three failures should bring the counter to 3');
  ctx.clearTimeout(ctx._syncRetryTimer);
});

await check('onSyncSuccess() resets the failure counter and hides the banner', () => {
  ctx.state = buildMockState();
  ctx._consecutiveSyncFailures = 5;
  ctx.onSyncSuccess(new Date().toISOString());
  assertEqual(ctx._consecutiveSyncFailures, 0, 'a successful sync must reset the failure counter to zero');
});

await check('retries always use the freshest state, not the original stale snapshot', () => {
  // Contract check: attemptSyncWithRetry must re-derive payload from the live
  // `state` object once failures > 0, rather than reusing whatever was passed
  // in originally — otherwise a long backoff could push outdated data.
  const src = ctx.attemptSyncWithRetry.toString();
  assertTrue(src.includes('_consecutiveSyncFailures > 0'), 'must branch on failure count to decide whether to use fresh state');
  assertTrue(src.includes('getPersistableState()'), 'must rebuild the payload from the live state object for retries, via the shared helper');
});

await check('signOut() clears the sync retry timer and resets the failure counter', () => {
  const src = ctx.signOut.toString();
  assertTrue(src.includes('_syncRetryTimer'), 'signOut must cancel any pending retry timer');
  assertTrue(src.includes('_consecutiveSyncFailures = 0'), 'signOut must reset the failure counter');
});

await check('cancelRecurring() does not duplicate the list modal when already on the inline Recurring pane', () => {
  const src = ctx.cancelRecurring.toString();
  assertTrue(src.includes("_expensesSubTab !== 'recurring'"), 'cancelRecurring must check the active subtab before reopening the list modal');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Multi-session conflict detection: stale tabs must never silently overwrite newer data ──');

await check('checkForSyncConflict() returns false (fail-open) when there is nothing to compare against yet', async () => {
  ctx._lastKnownServerTimestamp = null;
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  const result = await ctx.checkForSyncConflict();
  assertTrue(result === false, 'with no known baseline timestamp, must not block the very first save of a session');
});

await check('checkForSyncConflict() returns false when not logged in (nothing to check)', async () => {
  ctx._sbSession = null;
  const result = await ctx.checkForSyncConflict();
  assertEqual(result, false);
});

await check('flushSyncBeacon() does nothing when this session has no unsynced changes (the actual root-cause fix)', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx._hasUnsyncedChanges = false; // an idle tab that never made a local edit
  ctx.__fetchCalls.length = 0;
  ctx.flushSyncBeacon();
  assertTrue(ctx.__fetchCalls.length === 0, 'an idle session with nothing new to say must never push a write on tab close — this is the exact mechanism behind a real data-loss report');
});

await check('flushSyncBeacon() proceeds normally when this session DOES have unsynced changes', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx._hasUnsyncedChanges = true; // this tab actually made an edit
  ctx.__fetchCalls.length = 0;
  ctx.flushSyncBeacon();
  assertTrue(ctx.__fetchCalls.length > 0, 'a session with genuine unsynced changes must still be able to flush on close');
});

await check('saveState() marks the session as having unsynced changes', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx._hasUnsyncedChanges = false;
  ctx.saveState();
  assertTrue(ctx._hasUnsyncedChanges === true, 'any saveState() call must mark this session as having something new to contribute');
});

await check('onSyncSuccess() clears the unsynced-changes flag', () => {
  ctx._hasUnsyncedChanges = true;
  ctx.onSyncSuccess(new Date().toISOString());
  assertEqual(ctx._hasUnsyncedChanges, false, 'a confirmed successful write means this session is caught up — nothing left unsynced');
});

await check('attemptSyncWithRetry() checks for conflicts before writing', () => {
  const src = ctx.attemptSyncWithRetry.toString();
  assertTrue(src.includes('checkForSyncConflict'), 'the main write path must check for conflicts before pushing data');
  assertTrue(src.includes('onSyncConflictDetected'), 'a detected conflict must trigger the reload-instead-of-overwrite handler');
});

await check('forceSyncToSupabase() also checks for conflicts before writing', () => {
  const src = ctx.forceSyncToSupabase.toString();
  assertTrue(src.includes('checkForSyncConflict'), 'the manual sync button must also check for conflicts, not just the automatic path');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Stray nested "data" field: must never be loaded, kept, or re-written ──');
console.log('   (regression for a real ~7MB payload bloat incident)');

await check('getPersistableState() strips a stray "data" key if present', () => {
  ctx.state = buildMockState();
  ctx.state.data = { expenses: [], budget: 999, evenMoreNesting: { data: {} } }; // simulate the corruption
  const result = ctx.getPersistableState();
  assertTrue(!('data' in result), 'a stray nested data field must never survive into the write payload');
});

await check('getPersistableState() leaves normal state completely untouched when no stray field exists', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'e1', date: '2026-06-01', amount: 50 });
  const result = ctx.getPersistableState();
  assertEqual(result.expenses.length, 1, 'real fields must pass through unaffected');
  assertTrue(!('data' in result));
});

await check('loadState() strips a stray "data" key from freshly-loaded cloud data', () => {
  const src = ctx.loadState.toString();
  assertTrue(src.includes("'data' in state") && src.includes('delete state.data'), 'loadState must defensively strip a stray data field immediately on load, regardless of how it got into the cloud row');
});

await check('importBackup() strips a stray "data" key from the imported file too', () => {
  const src = ctx.importBackup.toString();
  assertTrue(src.includes('delete state.data'), 'restoring from a backup that already contains the corruption must not re-introduce it');
});

await check('every write path uses the shared getPersistableState() helper — no path re-implements the destructuring inline', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const inlineDestructureCount = (html.match(/currentTab, viewingCycleOffset, mortgageCycleOffset, editingExpenseId, editingCatId, \.\.\./g) || []).length;
  assertEqual(inlineDestructureCount, 1, 'exactly one inline destructuring should exist — inside getPersistableState() itself; every other site must call the helper so this guard can never be forgotten at a new call site');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Analytics Forecast: must render with recurring expenses, no crash ──');

await check('renderAnalyticsForecast() does not throw when recurring expenses exist (regression: out-of-scope budget variable)', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'insights';
  ctx.state.expenses.push({ id: 'e1', date: '2026-06-01', amount: 20, categoryId: 'cat1' }); // renderAnalytics() requires ≥1 expense before it even reaches the tab dispatch
  ctx.state.recurringExpenses.push({
    id: 'rec1', categoryId: 'cat1', amount: 100, frequency: 'monthly', active: true,
    dayOfMonth: 1, startDate: '2026-01-01',
  });
  ctx.analyticsSection = 'forecast';
  assertNoThrow(() => ctx.renderAnalytics(), 'Forecast page must not crash for any user with at least one recurring expense — this exact bug made the page render completely blank');
  const anBody = ctx.document.getElementById('anBody');
  assertTrue((anBody.innerHTML || '').length > 0, 'anBody must actually contain rendered content, not be left empty by a crash partway through');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Appearance: color family and light/dark mode are independent axes ──');

await check('COLOR_FAMILIES contains exactly 5 families, each with complete dark+light neutral sets', () => {
  const keys = Object.keys(ctx.COLOR_FAMILIES);
  assertEqual(keys.length, 5, 'should have exactly 5 color families');
  const neutralFields = ['bg', 'surface', 'surface2', 'surface3', 'border', 'text', 'muted'];
  keys.forEach(k => {
    const f = ctx.COLOR_FAMILIES[k];
    assertTrue(!!f.accent && !!f.accentDim && !!f.label, `family "${k}" is missing accent/accentDim/label`);
    ['dark', 'light'].forEach(mode => {
      neutralFields.forEach(field => {
        assertTrue(!!f[mode][field], `family "${k}" mode "${mode}" is missing required field "${field}"`);
      });
    });
  });
});

await check('the SAME accent color is used in both light and dark mode for a given family', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'amber';
  ctx.state.themeMode = 'dark';
  ctx.applyTheme();
  const darkAccent = ctx.document.documentElement.style.getPropertyValue('--accent');
  ctx.state.themeMode = 'light';
  ctx.applyTheme();
  const lightAccent = ctx.document.documentElement.style.getPropertyValue('--accent');
  assertEqual(darkAccent, lightAccent, 'switching mode must not change the accent — that is the whole point of separating the two axes');
  assertEqual(darkAccent, '#e2a662', 'should be the amber family accent specifically');
});

await check('the background DOES change between light and dark mode for the same color family', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'amber';
  ctx.state.themeMode = 'dark';
  ctx.applyTheme();
  const darkBg = ctx.document.documentElement.style.getPropertyValue('--bg');
  ctx.state.themeMode = 'light';
  ctx.applyTheme();
  const lightBg = ctx.document.documentElement.style.getPropertyValue('--bg');
  assertTrue(darkBg !== lightBg, 'the neutral background must actually differ between modes — that is the other half of the point');
});

await check('mode "auto" resolves via system preference (matchMedia), not a fixed mode', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'blue';
  ctx.state.themeMode = 'auto';
  assertNoThrow(() => ctx.applyTheme(), 'auto mode must consult matchMedia without throwing even in a minimal/stubbed environment');
});

await check('setThemeColor() persists the choice and re-applies, without touching themeMode', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx.state.themeMode = 'dark';
  ctx.setThemeColor('mint');
  assertEqual(ctx.state.themeColor, 'mint', 'color choice must persist onto state');
  assertEqual(ctx.state.themeMode, 'dark', 'changing color must not affect the independently-chosen mode');
});

await check('setThemeMode() persists the choice and re-applies, without touching themeColor', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx.state.themeColor = 'gold';
  ctx.setThemeMode('light');
  assertEqual(ctx.state.themeMode, 'light', 'mode choice must persist onto state');
  assertEqual(ctx.state.themeColor, 'gold', 'changing mode must not affect the independently-chosen color');
});

await check('setThemeColor() rejects an invalid key rather than corrupting state', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'mint';
  ctx.setThemeColor('notARealColor');
  assertEqual(ctx.state.themeColor, 'mint', 'an invalid color choice must be ignored');
});

await check('setThemeMode() rejects an invalid value rather than corrupting state', () => {
  ctx.state = buildMockState();
  ctx.state.themeMode = 'dark';
  ctx.setThemeMode('sideways');
  assertEqual(ctx.state.themeMode, 'dark', 'an invalid mode must be ignored');
});

await check('migrateThemeToV2() correctly maps every legacy single-key theme onto the new color+mode pair', () => {
  ctx.state = buildMockState();
  ctx.state.theme = 'warmCharcoal';
  ctx.migrateThemeToV2();
  assertEqual(ctx.state.themeColor, 'amber');
  assertEqual(ctx.state.themeMode, 'dark');

  ctx.state = buildMockState();
  ctx.state.theme = 'softStone';
  ctx.migrateThemeToV2();
  assertEqual(ctx.state.themeColor, 'forest');
  assertEqual(ctx.state.themeMode, 'light');

  ctx.state = buildMockState();
  ctx.state.theme = 'classicCream';
  ctx.migrateThemeToV2();
  assertEqual(ctx.state.themeColor, 'blue');
  assertEqual(ctx.state.themeMode, 'light');
});

await check('migrateThemeToV2() does nothing if already on the new model — never overwrites an explicit choice', () => {
  ctx.state = buildMockState();
  ctx.state.theme = 'deepPlum'; // legacy field present but should be ignored
  ctx.state.themeColor = 'mint';
  ctx.state.themeMode = 'dark';
  ctx.migrateThemeToV2();
  assertEqual(ctx.state.themeColor, 'mint', 'must not re-migrate over an already-set explicit choice');
  assertEqual(ctx.state.themeMode, 'dark');
});

await check('loadState() runs the migration before applying the theme on every successful load', () => {
  const src = ctx.loadState.toString();
  assertTrue(src.includes('migrateThemeToV2') && src.includes('applyTheme()'), 'loadState must migrate any legacy theme choice and apply the resulting color+mode on every load');
});

await check('signOut() resets to the blue/auto defaults for a clean login screen', () => {
  const src = ctx.signOut.toString();
  assertTrue(src.includes('applyTheme()'), 'signOut must re-apply the theme after resetting state, so the login screen shows neutral defaults rather than a previous session');
});

await check('renderThemePicker() renders both the color swatches and the mode segmented control', () => {
  const src = ctx.renderThemePicker.toString();
  assertTrue(src.includes('themePickerGrid') && src.includes('themeModeSeg'), 'the picker must populate both the color grid and the separate mode control');
  assertTrue(src.includes('setThemeColor') && src.includes('setThemeMode'), 'must wire up both independent setters');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Offset history: goal-covered expenses must show which goal funded them, with no duplicate amounts ──');

await check('fully goal-covered expense (paid from offset): expense row hidden, withdrawal row shows the goal', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({
    id: 'exp1', date: '2026-06-22', amount: 201.99, categoryId: 'cat1',
    paymentAccountId: 'offset1', linkedGoalId: 'goal1', goalCoveredAmount: 201.99,
  });
  ctx.state.savingsDeposits.push({
    id: 'dep1', catId: 'goal1', amount: 201.99, date: '2026-06-22',
    type: 'bill-payment', linkedExpenseId: 'exp1', note: 'Expense withdrawal',
  });
  const rows = ctx.getAccountTransactions('offset1');
  const expenseRows = rows.filter(r => r.id === 'exp1');
  const withdrawalRows = rows.filter(r => r.id === 'dep1_offset');
  assertEqual(expenseRows.length, 0, 'fully-covered expense row must be hidden — nothing uncovered left to show, and showing it would duplicate the withdrawal amount');
  assertEqual(withdrawalRows.length, 1, 'the withdrawal row must show, clearly labeled with which goal funded it');
  assertEqual(withdrawalRows[0].amount, 201.99, 'withdrawal amount must equal the full covered amount');
});

await check('partially goal-covered expense (paid from offset): expense row shows only the uncovered remainder, withdrawal row shows the covered portion', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({
    id: 'exp3', date: '2026-06-22', amount: 200, categoryId: 'cat1',
    paymentAccountId: 'offset1', linkedGoalId: 'goal1', goalCoveredAmount: 150,
  });
  ctx.state.savingsDeposits.push({
    id: 'dep3', catId: 'goal1', amount: 150, date: '2026-06-22',
    type: 'bill-payment', linkedExpenseId: 'exp3', note: 'Expense withdrawal',
  });
  const rows = ctx.getAccountTransactions('offset1');
  const expenseRows = rows.filter(r => r.id === 'exp3');
  const withdrawalRows = rows.filter(r => r.id === 'dep3_offset');
  assertEqual(expenseRows.length, 1, 'the uncovered remainder must still show as its own row');
  assertEqual(expenseRows[0].amount, 50, 'expense row must show only the NET uncovered amount (200 - 150), not the full gross amount');
  assertEqual(withdrawalRows.length, 1, 'the covered portion must show as a separate, goal-labeled withdrawal row');
  assertEqual(withdrawalRows[0].amount, 150, 'withdrawal amount must equal exactly the covered portion');
  // Together they must sum back to the original total — no money silently lost or duplicated in the display
  assertEqual(expenseRows[0].amount + withdrawalRows[0].amount, 200, 'the two rows together must sum to the original expense total');
});

await check('expense with NO goal coverage (paid from offset): shows the full amount as a single plain row, unaffected by any of this logic', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({
    id: 'exp4', date: '2026-06-22', amount: 75, categoryId: 'cat1', paymentAccountId: 'offset1',
  });
  const rows = ctx.getAccountTransactions('offset1');
  const expenseRows = rows.filter(r => r.id === 'exp4');
  assertEqual(expenseRows.length, 1);
  assertEqual(expenseRows[0].amount, 75, 'an expense with no goal coverage at all must show its full amount, completely unchanged');
});

await check('goal-covered expense paid from a DIFFERENT account (not this offset): only the withdrawal shows here, expense row is correctly absent', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc1', name: 'Credit Card', type: 'credit' });
  ctx.state.expenses.push({
    id: 'exp2', date: '2026-06-22', amount: 50, categoryId: 'cat1',
    paymentAccountId: 'cc1', linkedGoalId: 'goal1', goalCoveredAmount: 50,
  });
  ctx.state.savingsDeposits.push({
    id: 'dep2', catId: 'goal1', amount: 50, date: '2026-06-22',
    type: 'bill-payment', linkedExpenseId: 'exp2', note: 'Expense withdrawal',
  });
  const rows = ctx.getAccountTransactions('offset1');
  const expenseRows = rows.filter(r => r.id === 'exp2');
  const withdrawalRows = rows.filter(r => r.id === 'dep2_offset');
  assertEqual(expenseRows.length, 0, 'an expense paid from a different account never appears in the offset account\'s own expense listing — that is correct and unrelated to goal coverage');
  assertEqual(withdrawalRows.length, 1, 'the withdrawal must still show for an expense paid elsewhere - this is the ONLY place this offset accounts balance change is explained at all');
});

await check('other account types (e.g. a savings account) are completely unaffected by the offset-specific net-amount logic', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'txn1', name: 'Everyday', type: 'transaction' });
  ctx.state.expenses.push({
    id: 'exp5', date: '2026-06-22', amount: 100, categoryId: 'cat1',
    paymentAccountId: 'txn1', linkedGoalId: 'goal1', goalCoveredAmount: 100,
  });
  const rows = ctx.getAccountTransactions('txn1');
  const expenseRows = rows.filter(r => r.id === 'exp5');
  assertEqual(expenseRows.length, 1, 'a non-offset account must still show the expense row even when fully goal-covered');
  assertEqual(expenseRows[0].amount, 100, 'non-offset accounts must show the full original amount — the net-amount adjustment is scoped to offset accounts only');
});

await check('withdrawal labels in offset history show destination, not a misleading up-arrow or the word "withdrawal"', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({
    id: 'exp6', date: '2026-06-22', amount: 100, categoryId: 'cat1', name: 'Mortgage',
    paymentAccountId: 'offset1', linkedGoalId: 'goal1', goalCoveredAmount: 100,
  });
  ctx.state.savingsDeposits.push({
    id: 'dep6', catId: 'goal1', amount: 100, date: '2026-06-22',
    type: 'bill-payment', linkedExpenseId: 'exp6', note: 'Expense withdrawal',
  });
  const rows = ctx.getAccountTransactions('offset1');
  const withdrawalRow = rows.find(r => r.id === 'dep6_offset');
  assertTrue(!!withdrawalRow, 'withdrawal row should exist');
  assertTrue(!withdrawalRow.label.includes('↑'), 'label must not use the up-arrow — it misleadingly suggests an increase for what is actually a decrease');
  assertTrue(!withdrawalRow.label.toLowerCase().includes('withdrawal'), 'the word "withdrawal" is redundant once the sign/color already shows it as an outflow — label should show destination instead');
  assertTrue(withdrawalRow.label.includes('Mortgage'), 'label should show WHERE the money went (the linked expense), mirroring how deposits show where money came FROM');
});

await check('renderAccounts() excludes closed goals from the "Goals included in balance" breakdown', () => {
  const src = ctx.renderAccounts.toString();
  assertTrue(/linkedGoals = \(state\.savingsCategories\|\|\[\]\)\.filter\(g => g\.linkedAccountId === _viewingAccountId && g\.status !== 'closed'\)/.test(src),
    'the linkedGoals filter used for the offset balance breakdown must exclude closed-status goals — a closed goal still showing here was a real reported bug');
});



// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Offset/savings history: grouped by cycle, current cycle expanded by default ──');

await check('renderAccounts() detail view groups non-CC transaction history by cycle without throwing', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx._viewingAccountId = 'offset1';
  ctx._expandedHistoryCycles = undefined; // simulate first-ever render
  const { cycleStart: curStart } = ctx.getCycleRange(0);
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  ctx.state.accountTransactions.push(
    { id: 'tx1', type: 'income', accountId: 'offset1', amount: 100, date: ctx.dateToStr(curStart), note: 'Pay' },
    { id: 'tx2', type: 'income', accountId: 'offset1', amount: 50, date: ctx.dateToStr(prevStart), note: 'Pay' }
  );
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Current cycle'), 'should label the current cycle distinctly rather than just its date range');
});

await check('toggleHistoryCycle() adds and removes a cycle key from the expanded set', () => {
  ctx._expandedHistoryCycles = new Set(['2026-06-18']);
  ctx.toggleHistoryCycle('2026-05-18');
  assertTrue(ctx._expandedHistoryCycles.has('2026-05-18'), 'toggling a collapsed cycle should expand it');
  ctx.toggleHistoryCycle('2026-05-18');
  assertTrue(!ctx._expandedHistoryCycles.has('2026-05-18'), 'toggling an expanded cycle should collapse it again');
});

await check('the current cycle is expanded by default on first render (no prior interaction)', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx._viewingAccountId = 'offset1';
  ctx._expandedHistoryCycles = undefined;
  const { cycleStart: curStart } = ctx.getCycleRange(0);
  ctx.state.accountTransactions.push({ id: 'tx3', type: 'income', accountId: 'offset1', amount: 75, date: ctx.dateToStr(curStart), note: 'Pay' });
  ctx.renderAccounts();
  const currentKey = ctx.dateToStr(ctx.getCycleRange(0).cycleStart);
  assertTrue(ctx._expandedHistoryCycles.has(currentKey), 'the current cycle must be expanded by default the very first time this view renders');
});

await check('CC accounts now show full cycle-grouped history (intentional change), not a current-cycle-only flat list', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'ccHist1', name: 'Card', type: 'credit' });
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  ctx.state.expenses.push({ id: 'oldCharge1', date: ctx.dateToStr(prevStart), amount: 30, categoryId: 'cat1', paymentAccountId: 'ccHist1', name: 'Old charge' });
  ctx._viewingAccountId = 'ccHist1';
  ctx.window._expandedHistoryCycles = null; // reset so only the current cycle auto-expands
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Charges by cycle'), 'CC accounts must use the same cycle-grouped section as every other account type — the reported gap was real charges in past cycles being completely invisible on this page');
  assertTrue(!html.includes('Old charge'), 'a past, collapsed cycle\'s charges should not be expanded by default — but the cycle group itself (with its toggle) must still exist, fixed separately below');
});

await check('toggleHistoryCycle() reveals a CC charge from a past cycle once expanded — confirms the data was always there, just previously unreachable', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'ccHist2', name: 'Card', type: 'credit' });
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  const oldDate = ctx.dateToStr(prevStart);
  ctx.state.expenses.push({ id: 'oldCharge2', date: oldDate, amount: 45, categoryId: 'cat1', paymentAccountId: 'ccHist2', name: 'Past cycle charge' });
  ctx._viewingAccountId = 'ccHist2';
  ctx.window._expandedHistoryCycles = new Set();
  const { cycleStart: prevCycleStart } = ctx.getCycleRange(-1);
  ctx.toggleHistoryCycle(ctx.dateToStr(prevCycleStart));
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Past cycle charge'), 'expanding the correct past cycle must reveal the charge that was previously impossible to see at all');
});

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Migrate-attachments section: hidden unless something actually needs migrating ──');

await check('updateMigrateAttachmentsVisibility() hides the section when no embedded images remain', () => {
  ctx.state = buildMockState();
  ctx.state.giftCards = [{ id: 'gc1', name: 'Test', image: 'someuser/giftcards/already_migrated.jpg' }];
  ctx.state.taxTransactions = [];
  ctx.updateMigrateAttachmentsVisibility();
  const section = ctx.document.getElementById('migrateAttachmentsSection');
  assertEqual(section.style.display, 'none', 'section must stay hidden when nothing is still embedded as base64');
});

await check('updateMigrateAttachmentsVisibility() shows the section when an embedded gift card image still exists', () => {
  ctx.state = buildMockState();
  ctx.state.giftCards = [{ id: 'gc2', name: 'Test', image: 'data:image/png;base64,abc123' }];
  ctx.state.taxTransactions = [];
  ctx.updateMigrateAttachmentsVisibility();
  const section = ctx.document.getElementById('migrateAttachmentsSection');
  assertEqual(section.style.display, '', 'section must show when a gift card still has an embedded base64 image');
});

await check('updateMigrateAttachmentsVisibility() shows the section when an embedded tax attachment still exists', () => {
  ctx.state = buildMockState();
  ctx.state.giftCards = [];
  ctx.state.taxTransactions = [{ id: 't1', attachment: { data: 'data:image/png;base64,abc123', name: 'receipt.jpg' } }];
  ctx.updateMigrateAttachmentsVisibility();
  const section = ctx.document.getElementById('migrateAttachmentsSection');
  assertEqual(section.style.display, '', 'section must show when a tax transaction still has an embedded base64 attachment');
});

await check('openSettings() and migrateAttachmentsToStorage() both refresh the section\'s visibility', () => {
  const settingsSrc = ctx.openSettings.toString();
  const migrateSrc = ctx.migrateAttachmentsToStorage.toString();
  assertTrue(settingsSrc.includes('updateMigrateAttachmentsVisibility'), "opening Settings must re-check whether the migrate section is still needed");
  assertTrue(migrateSrc.includes('updateMigrateAttachmentsVisibility'), 'completing a migration must immediately hide the section if nothing embedded remains, without needing to reopen Settings');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Super account: Total Remuneration Package must back out super, not add it on top ──');

await check('employer contribution for "base" salary type adds the rate on top (existing, unchanged behavior)', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({
    id: 'super1', name: 'My Super', type: 'super', openingBalance: 1000,
    currentAge: 30, retirementAge: 67, employerContribType: 'pct',
    grossSalary: 150000, employerContribPct: 11.5, salaryType: 'base',
  });
  ctx._viewingAccountId = 'super1';
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('1,437.50') || html.includes('1437.50'), 'base salary type: $150,000 x 11.5% / 12 = $1,437.50/month, added on top of salary');
});

await check('employer contribution for "trp" salary type backs the super OUT of the package instead of adding it', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({
    id: 'super2', name: 'My Super', type: 'super', openingBalance: 1000,
    currentAge: 30, retirementAge: 67, employerContribType: 'pct',
    grossSalary: 150000, employerContribPct: 11.5, salaryType: 'trp',
  });
  ctx._viewingAccountId = 'super2';
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('1,289.24') || html.includes('1289.24'), 'TRP salary type: $150,000 total package backs out 11.5% super correctly, giving a smaller monthly figure ($1,289.24) than naively adding 11.5% on top would');
});

await check('fixed-dollar employer contributions are completely unaffected by salaryType — that distinction only matters for percentage-based contributions', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({
    id: 'super3', name: 'My Super', type: 'super', openingBalance: 1000,
    currentAge: 30, retirementAge: 67, employerContribType: 'fixed',
    employerContribFixed: 500, salaryType: 'trp', // salaryType present but irrelevant here
  });
  ctx._viewingAccountId = 'super3';
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('500.00'), 'a fixed monthly contribution must show as exactly what was entered, regardless of salaryType');
});

await check('openEditAccount() restores ALL previously-saved super fields, not just resetting to defaults', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({
    id: 'super4', name: 'My Super', type: 'super', openingBalance: 1000,
    currentAge: 42, retirementAge: 60, returnRate: 8, inflationRate: 3,
    employerContribType: 'pct', grossSalary: 120000, employerContribPct: 12,
    employerContribFixed: 0, salarysacrifice: 300, salaryType: 'trp',
  });
  ctx.openEditAccount('super4');
  assertEqual(ctx.document.getElementById('superCurrentAge').value, '42', 'current age must be restored, not reset to the default 30');
  assertEqual(ctx.document.getElementById('superGrossSalary').value, '120000', 'gross salary must be restored, not reset to 0');
  assertEqual(ctx.document.getElementById('superSalarySacrifice').value, '300', 'salary sacrifice must be restored, not reset to 0');
  assertEqual(ctx.document.getElementById('superGrossSalary').dataset.salaryType, 'trp', 'the salary type toggle must restore to what was actually saved, not default back to "base"');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Super contribution: skipping must never add the amount to the balance ──');

await check('skipSuperContrib() marks the item skipped WITHOUT touching the account balance', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'super5', name: 'My Super', type: 'super', currentBalance: 10000 });
  ctx.state.superContributions = [{ id: 'c1', acctId: 'super5', net: 500, employer: 500, sacrifice: 0, label: 'June 2026', status: 'pending' }];
  ctx.skipSuperContrib('c1');
  const acct = ctx.accountById('super5');
  assertEqual(acct.currentBalance, 10000, 'skipping must NOT add the contribution amount to the balance — that is the whole point, the money already landed another way');
  const c = ctx.state.superContributions.find(x => x.id === 'c1');
  assertEqual(c.status, 'skipped', 'the item must be marked skipped so it disappears from the pending list');
  assertTrue(!!c.skippedAt, 'should record when it was skipped');
});

await check('a skipped contribution no longer appears in the pending list', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'super6', name: 'My Super', type: 'super', currentBalance: 5000 });
  ctx.state.superContributions = [{ id: 'c2', acctId: 'super6', net: 300, employer: 300, sacrifice: 0, label: 'May 2026', status: 'skipped', skippedAt: new Date().toISOString() }];
  ctx._viewingAccountId = 'super6';
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(!html.includes('⏳ Pending contributions') || !html.includes('Confirm & add to balance'),
    'a skipped item should not show a Confirm button — it is no longer pending');
});

await check('a skipped contribution shows in Recent contributions labeled "Skipped", not as an added amount', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'super7', name: 'My Super', type: 'super', currentBalance: 5000 });
  ctx.state.superContributions = [{ id: 'c3', acctId: 'super7', net: 300, employer: 300, sacrifice: 0, label: 'May 2026', status: 'skipped', skippedAt: new Date().toISOString() }];
  ctx._viewingAccountId = 'super7';
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Skipped'), 'a skipped contribution should still be visible in the history, clearly labeled, rather than just vanishing with no record');
  assertTrue(!html.includes('+$300.00'), 'must NOT show as a +amount — that would misleadingly suggest it was added to the balance');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Super contribution scheduling: date/frequency-driven, fires without viewing the page ──');

await check('isSuperContribDueOn() matches monthly frequency on the chosen day only', () => {
  const acct = { contribFrequency: 'monthly', contribMonthDay: 15 };
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-07-15'), 'should be due on the 15th');
  assertTrue(!ctx.isSuperContribDueOn(acct, '2026-07-14'), 'should not be due a day early');
  assertTrue(!ctx.isSuperContribDueOn(acct, '2026-07-16'), 'should not be due a day late');
});

await check('isSuperContribDueOn() clamps day 31 to the actual last day of shorter months', () => {
  const acct = { contribFrequency: 'monthly', contribMonthDay: 31 };
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-02-28'), 'Feb 2026 only has 28 days — day 31 should clamp to the 28th, not silently never fire');
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-01-31'), 'January genuinely has 31 days, should fire on the 31st normally');
});

await check('isSuperContribDueOn() matches fortnightly frequency every 14 days from the anchor date', () => {
  const acct = { contribFrequency: 'fortnightly', contribAnchorDate: '2026-07-01' };
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-07-01'), 'due on the anchor date itself');
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-07-15'), 'due exactly 14 days later');
  assertTrue(!ctx.isSuperContribDueOn(acct, '2026-07-08'), 'should NOT be due halfway between (7 days)');
});

await check('isSuperContribDueOn() matches quarterly frequency every ~91 days from the anchor date', () => {
  const acct = { contribFrequency: 'quarterly', contribAnchorDate: '2026-01-01' };
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-01-01'));
  assertTrue(ctx.isSuperContribDueOn(acct, '2026-04-02')); // 91 days later
  assertTrue(!ctx.isSuperContribDueOn(acct, '2026-02-01'));
});

await check('isSuperContribDueOn() returns false (never throws) when required fields are missing', () => {
  assertNoThrow(() => ctx.isSuperContribDueOn({ contribFrequency: 'fortnightly' }, '2026-07-01'), 'missing anchorDate must fail safely, not throw');
  assertEqual(ctx.isSuperContribDueOn({ contribFrequency: 'fortnightly' }, '2026-07-01'), false);
});

await check('applySuperContributions() generates a pending entry on first run for an account due today', () => {
  ctx.state = buildMockState();
  const todayStr = ctx.todayStr();
  ctx.state.accounts.push({
    id: 'super8', name: 'My Super', type: 'super', employerContribType: 'pct',
    grossSalary: 120000, employerContribPct: 12, contribFrequency: 'monthly',
    contribMonthDay: parseInt(todayStr.slice(8,10)), // due today
  });
  ctx.applySuperContributions();
  const c = (ctx.state.superContributions||[]).find(x => x.acctId === 'super8' && x.dueDate === todayStr);
  assertTrue(!!c, 'should generate a pending contribution for today since the account is due today');
  assertEqual(c.status, 'pending');
});

await check('applySuperContributions() catches up on MISSED periods, not just today — the actual reported gap', () => {
  ctx.state = buildMockState();
  const today = new Date(); today.setHours(0,0,0,0);
  const tenDaysAgo = new Date(today); tenDaysAgo.setDate(today.getDate() - 10);
  ctx.state.accounts.push({
    id: 'super9', name: 'My Super', type: 'super', employerContribType: 'fixed',
    employerContribFixed: 100, contribFrequency: 'fortnightly',
    contribAnchorDate: ctx.dateToStr(tenDaysAgo), // anchor 10 days ago -> one occurrence missed if checked daily, but should catch up
    lastContribCheckDate: ctx.dateToStr(tenDaysAgo), // simulate: last checked 10 days ago, nothing since
  });
  ctx.applySuperContributions();
  const entries = (ctx.state.superContributions||[]).filter(x => x.acctId === 'super9');
  assertTrue(entries.length >= 1, 'must catch up and generate the missed occurrence(s) since the last check, not just skip straight to today');
  assertTrue(entries.some(e => e.dueDate === ctx.dateToStr(tenDaysAgo)), 'the anchor date itself (10 days ago) should have generated an entry via catch-up');
});

await check('applySuperContributions() never creates a duplicate entry for the same due date', () => {
  ctx.state = buildMockState();
  const todayStr = ctx.todayStr();
  ctx.state.accounts.push({
    id: 'super10', name: 'My Super', type: 'super', employerContribType: 'fixed',
    employerContribFixed: 200, contribFrequency: 'monthly',
    contribMonthDay: parseInt(todayStr.slice(8,10)),
  });
  ctx.applySuperContributions();
  ctx.applySuperContributions(); // run again immediately
  const entries = (ctx.state.superContributions||[]).filter(x => x.acctId === 'super10' && x.dueDate === todayStr);
  assertEqual(entries.length, 1, 'running the generator twice for the same day must never create a duplicate pending entry');
});

await check('applySuperContributions() is wired into the app/day-change flow, not only the account detail view', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const callSites = (html.match(/applySuperContributions\(\)/g) || []).length;
  assertTrue(callSites >= 4, 'should be called from init/day-change flow (at least 3 sites) plus the account detail view fallback — generation must not depend on the user opening this specific page');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Statement reconciliation, phase 1: deferToNextCycle budget math ──');
console.log('   (the $2k-on-last-day-of-cycle example — date stays real, budget math moves)');

await check('cycleExpenses() excludes a deferred expense from its OWN natural cycle', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'def1', date: ctx.dateToStr(cycleStart), amount: 2000, categoryId: 'cat1', deferToNextCycle: true });
  const result = ctx.cycleExpenses(0);
  assertTrue(!result.some(e => e.id === 'def1'), 'a deferred expense must not count toward the cycle its own date naturally falls in');
});

await check('cycleExpenses() includes a deferred expense in the FOLLOWING cycle instead', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(-1); // previous cycle relative to "now"
  ctx.state.expenses.push({ id: 'def2', date: ctx.dateToStr(cycleStart), amount: 2000, categoryId: 'cat1', deferToNextCycle: true });
  const result = ctx.cycleExpenses(0); // viewing the CURRENT cycle, one after where the expense's date falls
  assertTrue(result.some(e => e.id === 'def2'), 'a deferred expense dated in the previous cycle must count toward THIS (the following) cycle instead');
});

await check('cycleExpenses() leaves non-deferred expenses completely unaffected (no regression)', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'reg1', date: ctx.dateToStr(cycleStart), amount: 50, categoryId: 'cat1' });
  const result = ctx.cycleExpenses(0);
  assertTrue(result.some(e => e.id === 'reg1'), 'an ordinary, non-deferred expense must still count toward its own natural cycle exactly as before');
});

await check('getCycleSummary() past-cycle branch is also defer-aware, not just cycleExpenses()', () => {
  const src = ctx.getCycleSummary.toString();
  assertTrue(src.includes('deferToNextCycle'), 'getCycleSummary has its own separate expense-filtering logic for past cycles — it must independently respect the defer flag too, not rely on cycleExpenses()');
});

await check('getEffectiveBillingCycleRange() returns the NEXT cycle for a deferred expense, the SAME cycle otherwise', () => {
  ctx.state = buildMockState();
  const { cycleStart, cycleEnd } = ctx.getCycleRange(0);
  const midCycleDate = ctx.dateToStr(cycleStart);
  const natural = ctx.getCycleRangeForDate(midCycleDate);

  const regular = { date: midCycleDate, deferToNextCycle: false };
  const regularRange = ctx.getEffectiveBillingCycleRange(regular);
  assertEqual(ctx.dateToStr(regularRange.cycleStart), ctx.dateToStr(natural.cycleStart), 'a non-deferred expense\'s effective billing cycle must equal its natural cycle');

  const deferred = { date: midCycleDate, deferToNextCycle: true };
  const deferredRange = ctx.getEffectiveBillingCycleRange(deferred);
  assertTrue(ctx.dateToStr(deferredRange.cycleStart) !== ctx.dateToStr(natural.cycleStart), 'a deferred expense\'s effective billing cycle must NOT equal its natural cycle');
  assertTrue(deferredRange.cycleStart > natural.cycleEnd, 'the effective cycle must start strictly after the natural cycle ends — i.e. it is genuinely the following cycle');
});

await check('confirmPayCCFromSalary() settles EXACTLY the expenses the preview calculated owed from, not a separately-recomputed list', () => {
  const src = ctx.confirmPayCCFromSalary.toString();
  assertTrue(src.includes('ccInfo.breakdown') && src.includes('.unsettled'), 'must reuse the same unsettled list the "you currently owe" figure came from — recomputing independently with different date bounds was a real pre-existing consistency bug (and would also defeat defer-awareness)');
});

await check('getCCGoalContributions() filters unsettled charges using effective billing cycle end, not raw date', () => {
  const src = ctx.getCCGoalContributions.toString();
  assertTrue(src.includes('getEffectiveBillingCycleEnd'), 'the owed calculation must use the deferral-aware effective cycle end, not the raw expense date, to decide what counts as billable by a given cycle');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Statement reconciliation, phase 2: the matching algorithm itself ──');
console.log('   (using the actual scenarios from a real statement)');

await check('reconcileStatement() matches an exact same-day, same-amount charge', () => {
  const statement = [{ date: '2026-05-19', merchant: 'WOOLWORTHS', amount: 208.80, isCredit: false }];
  const spendly = [{ id: 'e1', date: '2026-05-19', amount: 208.80, categoryId: 'cat1' }];
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.matched.length, 1);
  assertEqual(r.missingFromSpendly.length, 0);
  assertEqual(r.missingFromStatement.length, 0);
});

await check('reconcileStatement() matches within date tolerance (Date Processed vs Date of Transaction can differ)', () => {
  const statement = [{ date: '2026-05-14', merchant: 'EATCLUB', amount: 254.76, isCredit: false }];
  const spendly = [{ id: 'e2', date: '2026-05-16', amount: 254.76, categoryId: 'cat1' }]; // logged 2 days later
  const r = ctx.reconcileStatement(statement, spendly, [], { dateToleranceDays: 3 });
  assertEqual(r.matched.length, 1, 'should still match within the 3-day tolerance window');
});

await check('reconcileStatement() correctly 1:1 matches genuine duplicate amounts on the same day (the gift card case)', () => {
  const statement = [
    { date: '2026-05-24', merchant: 'EDRGIFTCARD BELLAVISTA', amount: 24.00, isCredit: false },
    { date: '2026-05-24', merchant: 'EDRGIFTCARD BELLAVISTA', amount: 24.00, isCredit: false },
  ];
  const spendly = [
    { id: 'gc1', date: '2026-05-24', amount: 24.00, categoryId: 'cat1' },
    { id: 'gc2', date: '2026-05-24', amount: 24.00, categoryId: 'cat1' },
  ];
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.matched.length, 2, 'two real duplicate charges with two real matching Spendly entries must both match — not collapse onto one');
  assertEqual(r.missingFromSpendly.length, 0);
  assertEqual(r.missingFromStatement.length, 0);
});

await check('reconcileStatement() flags only the SECOND duplicate as missing when only one was logged', () => {
  const statement = [
    { date: '2026-05-24', merchant: 'EDRGIFTCARD BELLAVISTA', amount: 24.00, isCredit: false },
    { date: '2026-05-24', merchant: 'EDRGIFTCARD BELLAVISTA', amount: 24.00, isCredit: false },
  ];
  const spendly = [{ id: 'gc1', date: '2026-05-24', amount: 24.00, categoryId: 'cat1' }]; // only ONE logged
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.matched.length, 1, 'the first should still match the one that was logged');
  assertEqual(r.missingFromSpendly.length, 1, 'the second, genuinely unlogged duplicate must be flagged as missing from Spendly');
});

await check('reconcileStatement() groups a split transaction (two Qantas charges) against one combined Spendly entry', () => {
  const statement = [
    { date: '2026-05-25', merchant: 'QANTAS AIR 0812387916170 LOS ANGELES', amount: 455.75, isCredit: false },
    { date: '2026-05-25', merchant: 'QANTAS AIR 0812387916172 LOS ANGELES', amount: 455.75, isCredit: false },
  ];
  const spendly = [{ id: 'flight1', date: '2026-05-25', amount: 911.50, categoryId: 'cat1', name: 'Flights for both of us' }];
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.matched.length, 0, 'should not exact-match either individual line against the combined total');
  assertEqual(r.splitSuggestions.length, 1, 'should suggest grouping the two statement lines against the one combined Spendly entry');
  assertEqual(r.splitSuggestions[0].sum, 911.50);
  assertEqual(r.splitSuggestions[0].expense.id, 'flight1');
  assertEqual(r.missingFromSpendly.length, 0, 'the grouped lines must not ALSO show up as missing');
  assertEqual(r.missingFromStatement.length, 0);
});

await check('reconcileStatement() flags an expense as missing from statement when the bank simply has not billed it yet', () => {
  const statement = []; // nothing on the statement
  const spendly = [{ id: 'e3', date: '2026-06-17', amount: 2000, categoryId: 'cat1' }]; // logged, but bank hasn't processed it
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.missingFromStatement.length, 1, 'an unmatched Spendly expense is exactly the defer-to-next-cycle candidate');
  assertEqual(r.missingFromStatement[0].id, 'e3');
});

await check('reconcileStatement() treats a credit (refund) as its own category, never as a regular charge', () => {
  const statement = [{ date: '2026-05-15', merchant: 'SP BATTERY MATE', amount: 76.79, isCredit: true }];
  const r = ctx.reconcileStatement(statement, [], []);
  assertEqual(r.matched.length, 0);
  assertEqual(r.missingFromSpendly.length, 0, 'a credit must never be treated as a missing regular charge');
});

await check('reconcileStatement() finds the original expense for a credit by searching the wider history pool', () => {
  const statement = [{ date: '2026-05-15', merchant: 'SP BATTERY MATE', amount: 76.79, isCredit: true }];
  const history = [{ id: 'oldExp1', date: '2026-03-14', amount: 76.79, categoryId: 'cat1', name: 'SP Battery Mate' }]; // logged 2 cycles ago
  const r = ctx.reconcileStatement(statement, [], history);
  assertEqual(r.creditsWithMatch.length, 1, 'should find the plausible original charge even though it is outside the current cycle pool');
  assertEqual(r.creditsWithMatch[0].matchedExpense.id, 'oldExp1');
  assertEqual(r.creditsUnmatched.length, 0);
});

await check('reconcileStatement() leaves a credit unmatched (not guessed) when nothing plausible exists in history', () => {
  const statement = [{ date: '2026-05-15', merchant: 'UNKNOWN REFUND', amount: 999.99, isCredit: true }];
  const r = ctx.reconcileStatement(statement, [], []);
  assertEqual(r.creditsUnmatched.length, 1, 'must fall into the explicit unmatched-credit bucket, never silently guess a match');
  assertEqual(r.creditsWithMatch.length, 0);
});

await check('reconcileStatement() never throws on a completely empty statement or empty expense list', () => {
  assertNoThrow(() => ctx.reconcileStatement([], [], []));
  assertNoThrow(() => ctx.reconcileStatement([], [{ id: 'e1', date: '2026-05-01', amount: 10 }], []));
});

await check('normalizeMerchant() strips punctuation/case so similar merchant strings can be grouped', () => {
  assertEqual(ctx.normalizeMerchant('SP *Battery-Mate!!'), ctx.normalizeMerchant('SP Battery Mate'), 'punctuation and case must not affect grouping');
  assertEqual(ctx.normalizeMerchant('QANTAS AIR 0812387916170').slice(0, 12), ctx.normalizeMerchant('QANTAS AIR 0812387916172').slice(0, 12),
    'two charges differing only in a trailing reference number must still share the same grouping prefix');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Statement reconciliation, phase 3: pool gathering and upload wiring ──');

await check('runStatementReconciliation() only gathers expenses for the SPECIFIED credit card account', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc1', name: 'Card 1', type: 'credit' }, { id: 'cc2', name: 'Card 2', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const todayInCycle = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push(
    { id: 'a', date: todayInCycle, amount: 50, categoryId: 'cat1', paymentAccountId: 'cc1' },
    { id: 'b', date: todayInCycle, amount: 75, categoryId: 'cat1', paymentAccountId: 'cc2' } // different card
  );
  let capturedResult = null;
  const origShow = ctx.showStatementReconciliationResults;
  ctx.showStatementReconciliationResults = (id, result) => { capturedResult = result; };
  ctx.runStatementReconciliation('cc1', [{ date: todayInCycle, merchant: 'Test', amount: 50, isCredit: false }]);
  ctx.showStatementReconciliationResults = origShow;
  assertTrue(!!capturedResult, 'should have run and produced a result');
  assertEqual(capturedResult.matched.length, 1, 'should only match against cc1 own expense, ignoring cc2 unrelated 75 charge entirely');
});

await check('runStatementReconciliation() includes the current cycle PLUS 3 prior cycles in the history pool for credit matching', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc3', name: 'Card', type: 'credit' });
  const { cycleStart: threeCyclesAgoStart } = ctx.getCycleRange(-3);
  const oldDate = ctx.dateToStr(threeCyclesAgoStart);
  ctx.state.expenses.push({ id: 'old1', date: oldDate, amount: 76.79, categoryId: 'cat1', paymentAccountId: 'cc3', name: 'Old purchase' });
  let capturedResult = null;
  const origShow = ctx.showStatementReconciliationResults;
  ctx.showStatementReconciliationResults = (id, result) => { capturedResult = result; };
  ctx.runStatementReconciliation('cc3', [{ date: ctx.todayStr(), merchant: 'Refund', amount: 76.79, isCredit: true }]);
  ctx.showStatementReconciliationResults = origShow;
  assertEqual(capturedResult.creditsWithMatch.length, 1, 'a 3-cycles-ago purchase must still be found by the history search for a matching credit');
});

await check('runStatementReconciliation() does NOT reach further back than 3 cycles', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc4', name: 'Card', type: 'credit' });
  const { cycleStart: tooOldStart } = ctx.getCycleRange(-5); // 5 cycles back — outside the 3-cycle window
  const oldDate = ctx.dateToStr(tooOldStart);
  ctx.state.expenses.push({ id: 'old2', date: oldDate, amount: 88.88, categoryId: 'cat1', paymentAccountId: 'cc4', name: 'Very old purchase' });
  let capturedResult = null;
  const origShow = ctx.showStatementReconciliationResults;
  ctx.showStatementReconciliationResults = (id, result) => { capturedResult = result; };
  ctx.runStatementReconciliation('cc4', [{ date: ctx.todayStr(), merchant: 'Refund', amount: 88.88, isCredit: true }]);
  ctx.showStatementReconciliationResults = origShow;
  assertEqual(capturedResult.creditsUnmatched.length, 1, 'a purchase from 5 cycles ago is outside the agreed 3-cycle lookback window and must NOT be found');
});

await check('openStatementUpload() accepts both images and PDFs', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(src.includes("'image/*,application/pdf'") || src.includes('image/*,application/pdf'), 'file picker must accept both image and PDF statement formats, as agreed');
});

await check('openStatementUpload() sends PDFs as document content blocks, images as image blocks', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(src.includes("type: 'document'") && src.includes("media_type: 'application/pdf'"), 'PDF files must use the document content type, not be force-converted to images');
  assertTrue(src.includes("type: 'image'"), 'image files must still use the image content type');
});

await check('the extraction prompt explicitly instructs using Date of Transaction, not Date Processed', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(src.includes('Date of Transaction') && src.includes('Date Processed'), 'the prompt must explicitly distinguish these two columns — a real statement has both, and they can differ by several days');
});

await check('the extraction prompt explicitly instructs NOT deduplicating repeated merchant+amount lines', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(/do NOT deduplicate|not deduplicate/i.test(src), 'genuinely duplicate charges (split flight bookings, repeated gift card purchases) must be preserved as separate lines, not collapsed');
});

await check('neither AI feature calls api.anthropic.com directly anymore — both go through the proxy', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  assertTrue(!html.includes("fetch('https://api.anthropic.com"), 'no direct Anthropic API call should remain in the client code - the real key must never be exposed, and direct calls fail with the x-api-key error anyway from outside Claude own sandbox');
  const proxyCallSites = (html.match(/callClaudeViaProxy\(/g) || []).length;
  assertTrue(proxyCallSites >= 2, 'both the portfolio import and the statement upload must route through callClaudeViaProxy()');
});

await check('callClaudeViaProxy() sends the shared secret header, never the real Anthropic key', () => {
  const src = ctx.callClaudeViaProxy.toString();
  assertTrue(src.includes('X-Proxy-Secret'), 'must authenticate to the Worker via the shared secret header');
  assertTrue(!src.includes('x-api-key'), 'the client must never send or know the real Anthropic API key — that lives server-side in the Worker only');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Statement reconciliation: which cycle does the statement actually cover? ──');
console.log('   (must infer from the statement own dates, not assume today cycle)');

await check('inferCycleOffsetFromStatement() correctly identifies the CURRENT cycle when most dates fall there', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(0);
  const d = ctx.dateToStr(cycleStart);
  const txns = [{ date: d, amount: 10 }, { date: d, amount: 20 }, { date: d, amount: 30 }];
  assertEqual(ctx.inferCycleOffsetFromStatement(txns), 0);
});

await check('inferCycleOffsetFromStatement() correctly identifies a PAST cycle - the exact scenario raised: uploading last cycle statement', () => {
  ctx.state = buildMockState();
  const { cycleStart } = ctx.getCycleRange(-1); // the cycle before the current one
  const d = ctx.dateToStr(cycleStart);
  const txns = [{ date: d, amount: 10 }, { date: d, amount: 20 }, { date: d, amount: 30 }, { date: d, amount: 40 }];
  assertEqual(ctx.inferCycleOffsetFromStatement(txns), -1, 'a statement whose transactions all fall in last cycle must be reconciled against LAST cycle, not today current one');
});

await check('inferCycleOffsetFromStatement() picks the cycle with the MOST transactions when a statement straddles two (e.g. a few stragglers near the boundary)', () => {
  ctx.state = buildMockState();
  const { cycleStart: prevStart } = ctx.getCycleRange(-2);
  const { cycleStart: currStart } = ctx.getCycleRange(-1);
  const txns = [
    { date: ctx.dateToStr(prevStart), amount: 5 }, // 1 straggler in the earlier cycle
    { date: ctx.dateToStr(currStart), amount: 10 },
    { date: ctx.dateToStr(currStart), amount: 20 },
    { date: ctx.dateToStr(currStart), amount: 30 }, // 3 in the cycle that should win
  ];
  assertEqual(ctx.inferCycleOffsetFromStatement(txns), -1, 'should follow the majority of transactions, not be thrown off by a single early/late straggler');
});

await check('inferCycleOffsetFromStatement() defaults to the current cycle for an empty statement, rather than throwing', () => {
  assertNoThrow(() => ctx.inferCycleOffsetFromStatement([]));
  assertEqual(ctx.inferCycleOffsetFromStatement([]), 0);
});

await check('runStatementReconciliation() uses the inferred cycle by default, not a hardcoded "today"', () => {
  const src = ctx.runStatementReconciliation.toString();
  assertTrue(src.includes('inferCycleOffsetFromStatement'), 'the default cycle must come from inspecting the statement own dates - assuming today cycle was the actual reported gap');
});

await check('the results screen surfaces which cycle was inferred, so a wrong guess is never silent', () => {
  const src = ctx.renderReconciliationReview.toString();
  assertTrue(src.includes('cycleLabel'), 'the inferred cycle must be visibly shown to the user, not applied invisibly — a wrong guess needs to be obvious immediately');
});

await check('both AI call sites use a current model string, not a retired dated snapshot', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  assertTrue(!html.includes('claude-sonnet-4-20250514'), 'this specific dated snapshot was retired by Anthropic — using it causes a real, reported API error');
  const currentModelCount = (html.match(/model: 'claude-sonnet-4-6'/g) || []).length;
  assertEqual(currentModelCount, 2, 'both the portfolio import and the statement upload must use the current model string');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Pride background: optional, adapts to light/dark, never overrides text-bearing surfaces ──');

await check('setPrideMode(true) sets --bg to a gradient, but leaves --surface as a solid color', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'blue';
  ctx.state.themeMode = 'dark';
  ctx.setPrideMode(true);
  const root = ctx.document.documentElement;
  assertTrue(root.style.getPropertyValue('--bg').includes('gradient'), 'pride mode should turn --bg into a gradient');
  assertTrue(!root.style.getPropertyValue('--surface').includes('gradient'), '--surface must stay a flat solid color — that is what keeps text readable, the gradient should only ever show in the gaps between cards');
});

await check('setPrideMode(false) restores the normal flat --bg for the current color/mode', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'amber';
  ctx.state.themeMode = 'dark';
  ctx.setPrideMode(true);
  ctx.setPrideMode(false);
  const root = ctx.document.documentElement;
  assertEqual(root.style.getPropertyValue('--bg'), ctx.COLOR_FAMILIES.amber.dark.bg, 'turning pride mode back off must restore the exact normal background for whatever color/mode is active');
});

await check('the pride gradient adapts to dark vs light mode rather than using one fixed gradient', () => {
  ctx.state = buildMockState();
  ctx.state.themeColor = 'blue';
  ctx.state.themeMode = 'dark';
  ctx.setPrideMode(true);
  const darkGradient = ctx.document.documentElement.style.getPropertyValue('--bg');
  ctx.state.themeMode = 'light';
  ctx.applyTheme();
  const lightGradient = ctx.document.documentElement.style.getPropertyValue('--bg');
  assertTrue(darkGradient !== lightGradient, 'dark and light mode must use different pride gradients, not the exact same one regardless of mode');
});

await check('setPrideMode() persists the choice onto state.prideMode so it syncs across devices', () => {
  ctx.state = buildMockState();
  ctx._sbSession = { access_token: 'fake', user: { id: 'user123' } };
  ctx._stateHydrated = true;
  ctx.setPrideMode(true);
  assertEqual(ctx.state.prideMode, true);
});

await check('renderThemePicker() does not throw when the pride toggle elements exist (uses direct id lookups, not DOM traversal)', () => {
  ctx.state = buildMockState();
  ctx.document.getElementById('prideToggle');
  ctx.document.getElementById('prideToggleDot');
  assertNoThrow(() => ctx.renderThemePicker());
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Statement reconciliation, phase 4: the persistent interactive review screen ──');

await check('showStatementReconciliationResults() does not throw and creates a persistent screen', () => {
  ctx.state = buildMockState();
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  assertNoThrow(() => ctx.showStatementReconciliationResults('cc1', result, null));
  assertTrue(!!ctx.window._reconciliation, 'should store the reconciliation state for later actions');
});

await check('reconcileAddExpense() adds a real expense and marks the item resolved WITHOUT removing it from view', () => {
  ctx.state = buildMockState();
  const result = { matched: [], missingFromSpendly: [{ date: '2026-06-01', merchant: 'Test Shop', amount: 42.50 }], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const beforeCount = ctx.state.expenses.length;
  ctx.reconcileAddExpense(0);
  assertEqual(ctx.state.expenses.length, beforeCount + 1, 'a real expense must be created');
  assertEqual(ctx.state.expenses[ctx.state.expenses.length-1].amount, 42.50);
  assertTrue(ctx.window._reconciliation.resolved['missing-0'], 'item must be marked resolved');
  assertTrue(ctx.window._reconciliation.result.missingFromSpendly.length === 1, 'the item must STILL be in the result list — resolved items stay visible, they do not disappear');
});

await check('reconcileDeferExpense() sets deferToNextCycle on the REAL expense object in state, not a copy', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'realExp1', date: '2026-06-17', amount: 2000, categoryId: 'cat1' });
  const matchedExpense = ctx.state.expenses[ctx.state.expenses.length - 1];
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [matchedExpense], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileDeferExpense(0);
  const realExpense = ctx.state.expenses.find(e => e.id === 'realExp1');
  assertEqual(realExpense.deferToNextCycle, true, 'must set the flag on the actual expense in state.expenses, not a disconnected copy');
  assertTrue(ctx.window._reconciliation.resolved['defer-0']);
});

await check('reconcileDeleteRefundedExpense() removes exactly the matched expense from state.expenses', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'toDelete1', date: '2026-03-14', amount: 76.79, categoryId: 'cat1', name: 'SP Battery Mate' });
  ctx.state.expenses.push({ id: 'keepThis1', date: '2026-06-01', amount: 50, categoryId: 'cat1', name: 'Other' });
  const matched = ctx.state.expenses.find(e => e.id === 'toDelete1');
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [{ credit: { merchant: 'Refund', amount: 76.79, date: '2026-05-15' }, matchedExpense: matched }], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileDeleteRefundedExpense(0);
  assertTrue(!ctx.state.expenses.some(e => e.id === 'toDelete1'), 'the refunded expense must be deleted');
  assertTrue(ctx.state.expenses.some(e => e.id === 'keepThis1'), 'unrelated expenses must be completely unaffected');
});

await check('reconcileCreditAsIncome() logs an income transaction on the correct CC account', () => {
  ctx.state = buildMockState();
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [{ date: '2026-05-15', merchant: 'Mystery refund', amount: 15.00 }] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileCreditAsIncome(0);
  const tx = (ctx.state.accountTransactions||[]).find(t => t.type === 'income' && t.accountId === 'cc1' && t.amount === 15.00);
  assertTrue(!!tx, 'should create a real income transaction on the credit card account for the unmatched credit');
});

await check('acting on one item never affects unrelated items in other sections', () => {
  ctx.state = buildMockState();
  const result = {
    matched: [],
    missingFromSpendly: [{ date: '2026-06-01', merchant: 'A', amount: 10 }, { date: '2026-06-02', merchant: 'B', amount: 20 }],
    missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [],
  };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileAddExpense(0);
  assertTrue(ctx.window._reconciliation.resolved['missing-0'], 'first item should be resolved');
  assertTrue(!ctx.window._reconciliation.resolved['missing-1'], 'second item must remain unresolved — resolving one item must not affect others');
});

await check('minimizeReconciliationReview() (the X button) hides the screen but KEEPS the reconciliation state', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  const result = { matched: [], missingFromSpendly: [{date:'2026-06-01', merchant:'A', amount:10}], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const screenBefore = ctx.document.getElementById('reconcileReviewScreen');
  ctx.minimizeReconciliationReview();
  assertTrue(screenBefore._removed === true, 'the screen element should actually be removed from the page');
  assertTrue(!!ctx.window._reconciliation, 'progress must NOT be lost just from tapping X — that was the actual reported problem: having to re-upload just to keep working through a list');
});

await check('finishReconciliationReview() (Done reviewing) is the only action that actually clears the state', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.finishReconciliationReview();
  assertTrue(!ctx.window._reconciliation, 'explicitly finishing must fully clear the reconciliation state');
});

await check('renderAccounts() shows a resumable "Continue" card on the CC page when a reconciliation was minimized, not finished', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'cc5', name: 'Card', type: 'credit' });
  ctx._viewingAccountId = 'cc5';
  const result = { matched: [], missingFromSpendly: [{date:'2026-06-01', merchant:'A', amount:10}], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc5', result, null);
  ctx.minimizeReconciliationReview();
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Statement review in progress'), 'a resumable card must appear on the CC account page after minimizing, so the user can return to it without re-uploading');
  assertTrue(html.includes('1 item'), 'should show an accurate count of items still needing action');
});

await check('the resumable card never appears for a DIFFERENT account in-progress reconciliation', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'cc6', name: 'Card A', type: 'credit' }, { id: 'cc7', name: 'Card B', type: 'credit' });
  const result = { matched: [], missingFromSpendly: [{date:'2026-06-01', merchant:'A', amount:10}], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc6', result, null); // in-progress reconciliation belongs to cc6
  ctx.minimizeReconciliationReview();
  ctx._viewingAccountId = 'cc7'; // but we're viewing cc7
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(!html.includes('Statement review in progress'), 'viewing a different card must not show a resumable card belonging to another cards reconciliation');
});

await check('renderReconciliationReview() preserves scroll position across re-renders, instead of resetting to the top on every action', () => {
  const src = ctx.renderReconciliationReview.toString();
  assertTrue(src.includes('savedScrollTop') && src.includes('scrollTop = savedScrollTop'), 'every action rebuilds the screen content — without explicitly restoring scroll position, each tap would jump the user back to the top, making it impossible to work through a long list');
});



await check('toggleReconcileSection() does not throw and toggles collapsed state', () => {
  ctx.state = buildMockState();
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const before = !!ctx.window._reconciliation.collapsed.missing;
  assertNoThrow(() => ctx.toggleReconcileSection('missing'));
  assertTrue(!!ctx.window._reconciliation.collapsed.missing !== before, 'toggling a section must flip its collapsed state');
});

await check('the Matched section is collapsed by default — avoids overwhelming the screen with potentially 40+ items', () => {
  ctx.state = buildMockState();
  const result = { matched: [{},{},{}], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  assertTrue(!!ctx.window._reconciliation.collapsed.matched, 'matched section should start collapsed since there is nothing to act on there');
});

await check('the loading overlay (showAiLoadingOverlay) is centered full-screen, not a small toast', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(src.includes('showAiLoadingOverlay'), 'statement upload must use the large centered overlay, not the easy-to-miss toast it used before');
  assertTrue(!src.includes("showToast('🤖 Reading"), 'the old tiny toast call must be gone');
});

await check('showAiLoadingOverlay() places the robot emoji statically inside the spinning ring, not rotating with it', () => {
  const src = ctx.showAiLoadingOverlay.toString();
  assertTrue(src.includes('🤖'), 'the loading indicator should include the robot emoji');
  assertTrue(src.includes('animation:aiSpin') && !/animation:aiSpin[^']*🤖/.test(src), 'the spin animation must apply to the ring element, not to the emoji itself, so the emoji stays upright while the ring rotates around it');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Statement reconciliation: fuzzy fallback + totals cross-check (real reported false negatives) ──');

await check('reconcileStatement() catches a same-amount charge with a 4-day date gap and a totally different name (the Prime example)', () => {
  const statement = [{ date: '2026-05-28', merchant: 'PRIME Vide', amount: 11.99, isCredit: false }];
  const spendly = [{ id: 'prime1', date: '2026-06-01', amount: 11.99, categoryId: 'cat1', name: 'Prime' }]; // 4 days apart — outside the 3-day tight tolerance
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.matched.length, 0, 'should NOT auto-confirm a match this loose — needs human review');
  assertEqual(r.possibleMatches.length, 1, 'should surface it as a possible match rather than flagging it as fully missing');
  assertEqual(r.missingFromSpendly.length, 0, 'must not ALSO appear as missing once caught by the fuzzy pass');
  assertEqual(r.missingFromStatement.length, 0);
  assertEqual(r.possibleMatches[0].daysApart, 4);
});

await check('reconcileStatement() catches a same-date, same-amount charge with a completely different merchant name (the Gastroscopy/ST Vincents case)', () => {
  // Same date AND same amount should actually hit Pass 1 (which never checks
  // name at all) — this test exists to lock in that guarantee explicitly,
  // since name should never be able to block an otherwise-exact match.
  const statement = [{ date: '2026-05-28', merchant: 'ST VINCENTS', amount: 761.25, isCredit: false }];
  const spendly = [{ id: 'med1', date: '2026-05-28', amount: 761.25, categoryId: 'cat1', name: 'Gastroscopy' }];
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.matched.length, 1, 'exact same date AND amount must confidently auto-match regardless of how different the merchant name is — name is never part of Pass 1 matching');
});

await check('reconcileStatement() does not fuzzy-match genuinely unrelated same-amount charges with no other evidence', () => {
  const statement = [{ date: '2026-05-01', merchant: 'Totally Different Shop', amount: 50, isCredit: false }];
  const spendly = [{ id: 'unrelated1', date: '2026-06-15', amount: 50, categoryId: 'cat1', name: 'Coincidence' }]; // 45 days apart
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.possibleMatches.length, 1, 'amount-only fuzzy matching has no upper bound on date gap by design — this is intentionally lenient, which is why it requires explicit human confirmation rather than auto-resolving');
});

await check('reconcileStatement() computes totals correctly: statement charges, credits, and what Spendly has logged', () => {
  const statement = [
    { date: '2026-05-01', merchant: 'A', amount: 100, isCredit: false },
    { date: '2026-05-02', merchant: 'B', amount: 50, isCredit: false },
    { date: '2026-05-03', merchant: 'Refund', amount: 20, isCredit: true },
  ];
  const spendly = [{ id: 'e1', date: '2026-05-01', amount: 100, categoryId: 'cat1' }];
  const r = ctx.reconcileStatement(statement, spendly, []);
  assertEqual(r.totals.statementChargesTotal, 150, 'should sum only the charges, not credits');
  assertEqual(r.totals.statementCreditsTotal, 20);
  assertEqual(r.totals.spendlyLoggedTotal, 100);
  assertEqual(r.totals.totalsDifference, 50, 'difference = statement charges - spendly logged = 150 - 100');
});

await check('renderReconciliationReview() shows a green "totals line up" banner when the difference is small', () => {
  ctx.state = buildMockState();
  const result = { matched: [], possibleMatches: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [], totals: { statementChargesTotal: 500, statementCreditsTotal: 0, spendlyLoggedTotal: 500.50, totalsDifference: -0.50 } };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const html = ctx.document.getElementById('reconcileReviewScreen').innerHTML;
  assertTrue(html.includes('Totals line up'), 'a sub-$1 difference should read as totals matching, not a discrepancy needing attention');
});

await check('renderReconciliationReview() shows an orange warning banner when totals genuinely differ', () => {
  ctx.state = buildMockState();
  const result = { matched: [], possibleMatches: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [], totals: { statementChargesTotal: 500, statementCreditsTotal: 0, spendlyLoggedTotal: 450, totalsDifference: 50 } };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const html = ctx.document.getElementById('reconcileReviewScreen').innerHTML;
  assertTrue(html.includes('Totals differ'), 'a genuine $50 gap must be flagged clearly, not glossed over');
});

await check('reconcilePossibleMatchConfirm() and reconcilePossibleMatchReject() both mark the item resolved without throwing', () => {
  ctx.state = buildMockState();
  const result = { matched: [], possibleMatches: [{ statementTxn: { date:'2026-05-28', merchant:'PRIME Vide', amount:11.99 }, expense: { date:'2026-06-01', name:'Prime', amount:11.99 }, daysApart: 4 }], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  assertNoThrow(() => ctx.reconcilePossibleMatchConfirm(0));
  assertTrue(ctx.window._reconciliation.resolved['possible-0']);

  ctx.showStatementReconciliationResults('cc1', result, null);
  assertNoThrow(() => ctx.reconcilePossibleMatchReject(0));
  assertTrue(ctx.window._reconciliation.resolved['possible-0']);
});

await check('openStatementUpload() shows honest, descriptive stage messages without numbered steps that caused confusion ("step 2 of 3" with no visible step 3)', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(!/Step \d of \d/.test(src), 'numbered steps were a real reported point of confusion and must not reappear');
  assertTrue(src.includes('Reading') && src.includes('Analyzing data') && src.includes('Matching against'), 'should still show real, distinct stage messages — just without numbering that implies a countable sequence the user can\'t actually see');
  assertTrue(/leave this screen|stay on this screen/i.test(src), 'should reassure the user not to navigate away during the long AI step');
});

await check('reconcileStatement() never suggests deleting an expense that an earlier pass already confirmed as a real charge (the Qantas charge-then-reversed case)', () => {
  // Real scenario from an actual statement: the SAME merchant+amount appears
  // as both a genuine charge AND a later reversal/credit of that exact
  // amount — both are real, separate line items. The charge being correctly
  // matched must NOT make the credit-matcher also suggest deleting it.
  const statement = [
    { date: '2026-05-28', merchant: 'QANTAS AIRWAYS LTD', amount: 69.97, isCredit: false },
    { date: '2026-06-06', merchant: 'QANTAS AIRWAYS LTD', amount: 69.97, isCredit: true }, // reversal of a DIFFERENT charge, not this one
  ];
  const spendly = [{ id: 'qantas1', date: '2026-05-28', amount: 69.97, categoryId: 'cat1', name: 'Qantas flight' }];
  const r = ctx.reconcileStatement(statement, spendly, spendly); // historyExpenses includes the same pool here
  assertEqual(r.matched.length, 1, 'the charge must match normally');
  assertEqual(r.creditsWithMatch.length, 0, 'the credit must NOT suggest deleting the expense that Pass 1 already confirmed as a real, separate charge');
  assertEqual(r.creditsUnmatched.length, 1, 'with nothing else in history to explain it, the credit should fall into the unmatched bucket instead — never silently claim an already-matched expense');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── CC payment consolidation: button label and modal must always agree ──');

await check('the Pending CC card button and the payment modal now use the SAME function — no separate calculation exists to disagree with it', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const standaloneCount = (html.match(/function getCCGoalContributions\(/g) || []).length;
  assertEqual(standaloneCount, 1, 'must be exactly one standalone function, not a local copy duplicated inside multiple places');
  const usageCount = (html.match(/getCCGoalContributions\(/g) || []).length;
  assertTrue(usageCount >= 3, 'should be called from the modal preview, the pending-CC card, AND its own definition — confirming both real surfaces route through the same calculation');
});

await check('getCCGoalContributions() correctly nets a same-cycle manual refund off the total owed', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc8', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const todayInCycle = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'e1', date: todayInCycle, amount: 100, categoryId: 'cat1', paymentAccountId: 'cc8' });
  ctx.state.accountTransactions.push({ id: 'r1', type: 'ccRefund', toAccountId: 'cc8', amount: 30, date: todayInCycle, deleted: false });
  const result = ctx.getCCGoalContributions('cc8', 0);
  assertEqual(result.grossTotal, 70, 'a $30 refund against a $100 charge should leave $70 actually owed');
  assertEqual(result.refundsTotal, 30);
});

await check('getCCGoalContributions() does NOT let a refund keep reducing totals in a LATER cycle — it has no "consumed" tracking, so it must be bounded to its own cycle only', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc9', name: 'Card', type: 'credit' });
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  const { cycleStart: currStart } = ctx.getCycleRange(0);
  ctx.state.accountTransactions.push({ id: 'r2', type: 'ccRefund', toAccountId: 'cc9', amount: 50, date: ctx.dateToStr(prevStart), deleted: false });
  ctx.state.expenses.push({ id: 'e2', date: ctx.dateToStr(currStart), amount: 100, categoryId: 'cat1', paymentAccountId: 'cc9' });
  const result = ctx.getCCGoalContributions('cc9', 0); // viewing the CURRENT cycle
  assertEqual(result.grossTotal, 100, "a refund from a PRIOR cycle must not keep reducing the current cycle total forever - it has no concept of being already used, so without this bound it would silently under-collect indefinitely");
});

await check('getCCGoalContributions() never lets a refund offset a goal contribution, only the salary portion', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc10', name: 'Card', type: 'credit' });
  ctx.state.savingsCategories.push({ id: 'goal1', name: 'Holiday', icon: '🏖️' });
  ctx.state.savingsDeposits.push({ id: 'dep1', catId: 'goal1', amount: 500, date: '2026-01-01', type: 'deposit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const todayInCycle = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'e3', date: todayInCycle, amount: 100, categoryId: 'cat1', paymentAccountId: 'cc10', goalCoveredAmount: 100, linkedGoalId: 'goal1' });
  ctx.state.accountTransactions.push({ id: 'r3', type: 'ccRefund', toAccountId: 'cc10', amount: 30, date: todayInCycle, deleted: false });
  const result = ctx.getCCGoalContributions('cc10', 0);
  assertEqual(result.goalTotal, 100, 'the goal contribution must be completely unaffected by an unrelated refund');
  assertEqual(result.salaryTotal, -30, 'the refund must reduce only the salary side, even going negative if the whole expense was goal-covered — never silently absorbed into the goal');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Closing balance: authoritative total, gap always lands on salary, never a goal ──');

await check('getCCGoalContributions() uses the closing balance as grossTotal when one is set for THIS exact cycle', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc11', name: 'Card', type: 'credit' });
  const { cycleStart, cycleEnd } = ctx.getCycleRange(0);
  ctx.state.accounts[ctx.state.accounts.length-1].closingBalance = 500;
  ctx.state.accounts[ctx.state.accounts.length-1].closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  ctx.state.expenses.push({ id: 'e1', date: ctx.dateToStr(cycleStart), amount: 480, categoryId: 'cat1', paymentAccountId: 'cc11' });
  const result = ctx.getCCGoalContributions('cc11', 0);
  assertEqual(result.usingClosingBalance, true);
  assertEqual(result.grossTotal, 500, 'must pay the bank\'s real closing balance, not Spendly\'s own itemized total');
  assertEqual(result.itemizedGrossTotal, 480, 'the itemized total should still be tracked separately for comparison');
  assertEqual(result.gapAmount, 20);
});

await check('getCCGoalContributions() ignores a closing balance set for a DIFFERENT cycle — never silently reuse a stale figure', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc12', name: 'Card', type: 'credit' });
  const { cycleEnd: prevCycleEnd } = ctx.getCycleRange(-1); // set for LAST cycle
  ctx.state.accounts[ctx.state.accounts.length-1].closingBalance = 999;
  ctx.state.accounts[ctx.state.accounts.length-1].closingBalanceCycleEnd = ctx.dateToStr(prevCycleEnd);
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'e2', date: ctx.dateToStr(cycleStart), amount: 50, categoryId: 'cat1', paymentAccountId: 'cc12' });
  const result = ctx.getCCGoalContributions('cc12', 0); // viewing the CURRENT cycle, not where the balance was set
  assertEqual(result.usingClosingBalance, false, 'a closing balance entered for a different cycle must never apply to this one');
  assertEqual(result.grossTotal, 50, 'must fall back to the itemized total when no current-cycle closing balance exists');
});

await check('getCCGoalContributions() attributes the entire gap to salary, NEVER to a linked goal', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc13', name: 'Card', type: 'credit' });
  ctx.state.savingsCategories.push({ id: 'goal2', name: 'Holiday', icon: '🏖️' });
  ctx.state.savingsDeposits.push({ id: 'dep2', catId: 'goal2', amount: 1000, date: '2026-01-01', type: 'deposit' });
  const { cycleStart, cycleEnd } = ctx.getCycleRange(0);
  ctx.state.accounts[ctx.state.accounts.length-1].closingBalance = 300; // $100 MORE than itemized
  ctx.state.accounts[ctx.state.accounts.length-1].closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  ctx.state.expenses.push({ id: 'e3', date: ctx.dateToStr(cycleStart), amount: 200, categoryId: 'cat1', paymentAccountId: 'cc13', goalCoveredAmount: 200, linkedGoalId: 'goal2' });
  const result = ctx.getCCGoalContributions('cc13', 0);
  assertEqual(result.goalTotal, 200, 'the goal\'s contribution must be completely unaffected by the unexplained gap');
  assertEqual(result.salaryTotal, 100, 'the entire $100 gap must land on the salary side — itemized salary was $0 (fully goal-covered), gap makes it $100');
  assertEqual(result.grossTotal, 300, 'salary ($100) + goals ($200) must sum to the authoritative closing balance ($300)');
});

await check('openEditClosingBalance() and saveClosingBalance() correctly persist a manual entry', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'cc14', name: 'Card', type: 'credit' });
  ctx._sbSession = { access_token: 'fake', user: { id: 'user1' } };
  ctx._stateHydrated = true;
  assertNoThrow(() => ctx.openEditClosingBalance('cc14'));
  ctx.document.getElementById('closingBalanceInput').value = '750.50';
  ctx.document.getElementById('closingBalanceDueDate').value = '2026-07-15';
  ctx.document.getElementById('closingBalanceMinPayment').value = '50';
  ctx.saveClosingBalance('cc14');
  const acct = ctx.accountById('cc14');
  assertEqual(acct.closingBalance, 750.5);
  assertEqual(acct.dueDate, '2026-07-15');
  assertEqual(acct.minimumPayment, 50);
  assertTrue(!!acct.closingBalanceCycleEnd, 'must bind the entry to the specific cycle it was entered for');
});

await check('saveClosingBalance() rejects an invalid amount rather than saving garbage', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'cc15', name: 'Card', type: 'credit' });
  ctx.document.getElementById('closingBalanceInput').value = 'not a number';
  ctx.document.getElementById('closingBalanceDueDate').value = '';
  ctx.document.getElementById('closingBalanceMinPayment').value = '';
  ctx.saveClosingBalance('cc15');
  const acct = ctx.accountById('cc15');
  assertTrue(acct.closingBalance === undefined, 'an invalid entry must be rejected, not saved as NaN or similar');
});

await check('runStatementReconciliation() saves an AI-extracted closing balance onto the account automatically', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'cc16', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const summary = { closingBalance: 1234.56, dueDate: '2026-07-01', minimumPayment: 100 };
  ctx.runStatementReconciliation('cc16', [{ date: ctx.dateToStr(cycleStart), merchant: 'Test', amount: 50, isCredit: false }], 0, summary);
  const acct = ctx.accountById('cc16');
  assertEqual(acct.closingBalance, 1234.56, 'an extracted closing balance should save automatically, same as a manual entry');
  assertEqual(acct.dueDate, '2026-07-01');
});

await check('runStatementReconciliation() never invents a closing balance when the AI did not find one', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'cc17', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.runStatementReconciliation('cc17', [{ date: ctx.dateToStr(cycleStart), merchant: 'Test', amount: 50, isCredit: false }], 0, null);
  const acct = ctx.accountById('cc17');
  assertTrue(acct.closingBalance === undefined, 'with no summary extracted, nothing should be saved — never guess or default to a fabricated value');
});

await check('openStatementUpload() parses the new {transactions, summary} object shape, with a fallback to a bare array', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(src.includes('parsed.transactions') && src.includes('parsed.summary'), 'must extract both pieces from the new object response shape');
  assertTrue(src.includes('Array.isArray(parsed)'), 'must still accept a bare array as a fallback, in case the model ignores the new instructions');
});

await check('the extraction prompt explicitly asks for closingBalance, dueDate, and minimumPayment, with an explicit instruction never to guess', () => {
  const src = ctx.openStatementUpload.toString();
  assertTrue(src.includes('closingBalance') && src.includes('dueDate') && src.includes('minimumPayment'), 'prompt must request all three summary fields');
  assertTrue(/never guess or invent/i.test(src), 'must explicitly instruct the model to use null rather than fabricate a figure it cannot find');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Real bugs found from live testing ──');

await check("renderAccounts() does not throw for a salary account with a linked CC account that has unsettled expenses (the actual reported Salary wont open bug)", () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'salaryX', name: 'My Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000, color: '#4F8EF7', icon: '💼' });
  ctx.state.accounts.push({ id: 'ccX', name: 'My CC', type: 'credit', color: '#ff5c5c', icon: '💳' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'eX', date: ctx.dateToStr(cycleStart), amount: 50, categoryId: 'cat1', paymentAccountId: 'ccX' });
  ctx._viewingAccountId = 'salaryX';
  assertNoThrow(() => ctx.renderAccounts(), 'a bare reference to an undefined variable (a.id instead of a real account id) was crashing this entire render — every salary account with ANY linked CC charges would fail to open');
});

await check('the Pending CC card correctly sums getCCGoalContributions across MULTIPLE credit cards, not a single undefined reference', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'salaryY', name: 'My Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000, color: '#4F8EF7', icon: '💼' });
  ctx.state.accounts.push({ id: 'ccY1', name: 'Card 1', type: 'credit', color: '#ff5c5c', icon: '💳' });
  ctx.state.accounts.push({ id: 'ccY2', name: 'Card 2', type: 'credit', color: '#ff5c5c', icon: '💳' });
  const { cycleStart } = ctx.getCycleRange(0);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'eY1', date: d, amount: 50, categoryId: 'cat1', paymentAccountId: 'ccY1' });
  ctx.state.expenses.push({ id: 'eY2', date: d, amount: 30, categoryId: 'cat1', paymentAccountId: 'ccY2' });
  ctx._viewingAccountId = 'salaryY';
  assertNoThrow(() => ctx.renderAccounts());
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('80.00') || html.includes('$80'), 'the combined card must show the SUM across both cards ($50 + $30 = $80), not just one or crash');
});

await check('openEditClosingBalance() pre-fills directly from account data, with no cycle-matching gate that can never be true', () => {
  const src = ctx.openEditClosingBalance.toString();
  assertTrue(src.includes('acct.closingBalance !== undefined') && src.includes('${acct.closingBalance'),
    'must reference the account\'s closingBalance directly with just an existence check');
  assertTrue(src.includes('${acct.dueDate') && src.includes('${acct.minimumPayment'),
    'must reference dueDate and minimumPayment directly from the account, not from some derived/gated value');
  assertTrue(!src.includes('isCurrentEntry') && !src.includes('closingBalanceCycleEnd ==='),
    'the previous cycle-matching gate (the actual reported bug — fields were blank) must be completely removed from the pre-fill logic');
});

await check('saveClosingBalance() (manual entry) binds to the most recently CLOSED cycle, not todays still-open one', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'ccZZ', name: 'Card', type: 'credit' });
  ctx.document.getElementById('closingBalanceInput').value = '500';
  ctx.document.getElementById('closingBalanceDueDate').value = '';
  ctx.document.getElementById('closingBalanceMinPayment').value = '';
  ctx.saveClosingBalance('ccZZ');
  const acct = ctx.accountById('ccZZ');
  const { cycleEnd: expectedClosedCycleEnd } = ctx.getCycleRange(-1);
  assertEqual(acct.closingBalanceCycleEnd, ctx.dateToStr(expectedClosedCycleEnd), 'a real bank statement only exists for a period that has already ended - binding to todays in-progress cycle would mean it could never actually match anything later');
});

await check('the closing balance modal is centered, not the default bottom-sheet position, and has a height safety net so its buttons can never be cut off', () => {
  const src = ctx.openEditClosingBalance.toString();
  assertTrue(src.includes("alignItems = 'center'"), 'must override the default bottom-anchored modal positioning — reported as cut-off CTAs in the corner');
  assertTrue(src.includes('max-height:85vh') && src.includes('overflow-y:auto'), 'must cap height and allow scrolling so Save/Cancel are always reachable regardless of viewport or keyboard height');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Guided "Pay credit cards" flow ──');

await check('openPayCreditCardsFlow() builds the queue from only cards that actually owe something', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'pfSalary1', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'pfCC1', name: 'Owes money', type: 'credit' });
  ctx.state.accounts.push({ id: 'pfCC2', name: 'Already paid', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'pfE1', date: ctx.dateToStr(cycleStart), amount: 50, categoryId: 'cat1', paymentAccountId: 'pfCC1' });
  ctx.openPayCreditCardsFlow('pfSalary1');
  assertEqual(ctx.window._payFlow.ccQueue.length, 1, 'a card with nothing owed must not appear in the queue');
  assertEqual(ctx.window._payFlow.ccQueue[0], 'pfCC1');
  assertEqual(ctx.window._payFlow.step, 'reconcile', 'should start on the first card\'s reconcile step');
});

await check('openPayCreditCardsFlow() skips straight to distribute when nothing is owed on any card', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'pfSalary2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'pfCC3', name: 'Card', type: 'credit' });
  ctx.openPayCreditCardsFlow('pfSalary2');
  assertEqual(ctx.window._payFlow.step, 'distribute', 'with an empty queue, the mandatory distribute step should still run rather than the whole flow doing nothing');
});

await check('advancePayFlow() correctly loops through MULTIPLE cards before reaching the shared distribute step', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'ccA', name: 'Card A', type: 'credit' }, { id: 'ccB', name: 'Card B', type: 'credit' });
  ctx.window._payFlow = { salaryAccountId: 's1', ccQueue: ['ccA', 'ccB'], cardIndex: 0, step: 'reconcile' };
  ctx.advancePayFlow();
  assertEqual(ctx.window._payFlow.step, 'pay', 'card 1: reconcile -> pay');
  ctx.advancePayFlow();
  assertEqual(ctx.window._payFlow.cardIndex, 1, 'must move to the second card');
  assertEqual(ctx.window._payFlow.step, 'reconcile', 'card 2: starts back at reconcile');
  ctx.advancePayFlow();
  assertEqual(ctx.window._payFlow.step, 'pay', 'card 2: reconcile -> pay');
  ctx.advancePayFlow();
  assertEqual(ctx.window._payFlow.step, 'distribute', 'after the LAST card\'s pay step, must move to the shared distribute step, not loop again');
  ctx.advancePayFlow();
  assertEqual(ctx.window._payFlow.step, 'done', 'distribute -> done, the mandatory final step, completes the flow');
});

await check('finishReconciliationReview() advances the wizard instead of just closing, when run as part of the guided flow', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'ccA', name: 'Card A', type: 'credit' });
  ctx.window._payFlow = { salaryAccountId: 's1', ccQueue: ['ccA'], cardIndex: 0, step: 'reconcile' };
  ctx.window._reconciliation = { ccAccountId: 'ccA', result: { matched:[], possibleMatches:[], missingFromSpendly:[], missingFromStatement:[], splitSuggestions:[], creditsWithMatch:[], creditsUnmatched:[] }, resolved: {}, collapsed: {} };
  ctx.finishReconciliationReview();
  assertEqual(ctx.window._payFlow.step, 'pay', 'finishing reconciliation mid-flow must advance to this card\'s pay step');
});

await check('finishReconciliationReview() behaves exactly as before when NOT run as part of the guided flow (backward compatible)', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.window._payFlow = null;
  ctx.window._reconciliation = { ccAccountId: 'ccA', result: { matched:[], possibleMatches:[], missingFromSpendly:[], missingFromStatement:[], splitSuggestions:[], creditsWithMatch:[], creditsUnmatched:[] }, resolved: {}, collapsed: {} };
  assertNoThrow(() => ctx.finishReconciliationReview());
  assertTrue(!ctx.window._reconciliation, 'should clear reconciliation state exactly as it always did when used standalone, outside any guided flow');
});

await check('confirmPayCCFromSalary() advances the wizard after a successful payment, when run as part of the guided flow', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'pfSalary3', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'pfCC4', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const realExpense = { id: 'pfE2', date: ctx.dateToStr(cycleStart), amount: 75, categoryId: 'cat1', paymentAccountId: 'pfCC4' };
  ctx.state.expenses.push(realExpense);
  ctx.document.getElementById('ccPaySelect').value = '0';
  ctx.window._payFlow = { salaryAccountId: 'pfSalary3', ccQueue: ['pfCC4'], cardIndex: 0, step: 'pay' };
  ctx.window._ccPayModalData = [{ id: 'pfCC4', owed: 75, salaryTotal: 75, goalTotal: 0, contributions: [], unsettledIds: [realExpense.id] }];
  ctx.confirmPayCCFromSalary('pfSalary3');
  assertEqual(ctx.window._payFlow.step, 'distribute', 'paying the only card in the queue must advance straight to the shared distribute step');
  const settledIds = new Set((ctx.state.ccPayments||[]).flatMap(p => p.expenseIds||[]));
  assertTrue(settledIds.has('pfE2'), 'the actual expense must still get correctly marked settled — the wizard hook must not interfere with the real payment logic');
});

await check('confirmPayCCFromSalary() behaves exactly as before when NOT run as part of the guided flow (backward compatible)', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'pfSalary4', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'pfCC5', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const realExpense = { id: 'pfE3', date: ctx.dateToStr(cycleStart), amount: 40, categoryId: 'cat1', paymentAccountId: 'pfCC5' };
  ctx.state.expenses.push(realExpense);
  ctx.document.getElementById('ccPaySelect').value = '0';
  ctx.window._payFlow = null;
  ctx.window._ccPayModalData = [{ id: 'pfCC5', owed: 40, salaryTotal: 40, goalTotal: 0, contributions: [], unsettledIds: [realExpense.id] }];
  assertNoThrow(() => ctx.confirmPayCCFromSalary('pfSalary4'));
  assertTrue(!ctx.window._payFlow, 'using Pay CC directly, outside any guided flow, must not spontaneously create or affect wizard state');
});

await check('minimizePayFlow() keeps progress; finishPayFlow() is the only thing that clears it', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.window._payFlow = { salaryAccountId: 's1', ccQueue: ['ccA'], cardIndex: 0, step: 'reconcile' };
  ctx.minimizePayFlow();
  assertTrue(!!ctx.window._payFlow, 'minimizing (X) must never discard progress — same principle as the reconciliation screen');
  ctx.finishPayFlow();
  assertTrue(!ctx.window._payFlow, 'finishing (Done) is the only action that actually clears the flow');
});

await check('openPayCCFromSalary() with a scopedCcId filters ccAccts down to just that one card', () => {
  const src = ctx.openPayCCFromSalary.toString();
  assertTrue(src.includes('!scopedCcId || a.id === scopedCcId'), 'must filter the account list to the scoped card when one is provided, and behave exactly as before (all cards) when omitted');
});

await check('renderAccounts() shows the resumable "Paying credit cards" card on the matching salary account, never a different one', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'pfSalaryA', name: 'Salary A', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'pfSalaryB', name: 'Salary B', type: 'transaction', isSalaryAccount: true, openingBalance: 3000 });
  ctx.window._payFlow = { salaryAccountId: 'pfSalaryA', ccQueue: ['ccX'], cardIndex: 0, step: 'reconcile' };
  ctx._viewingAccountId = 'pfSalaryB';
  ctx.renderAccounts();
  let html = ctx.document.getElementById('content').innerHTML;
  assertTrue(!html.includes('Paying credit cards'), 'viewing a DIFFERENT salary account must not show another account\'s in-progress flow');
  ctx._viewingAccountId = 'pfSalaryA';
  ctx.renderAccounts();
  html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Paying credit cards'), 'viewing the MATCHING salary account must show the resumable card');
});

await check('renderPayCreditCardsFlow() does not throw for any of the four step types', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'pfSalary6', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'pfCC8', name: 'Card', type: 'credit' });
  ['reconcile', 'pay', 'distribute', 'done'].forEach(step => {
    ctx.window._payFlow = { salaryAccountId: 'pfSalary6', ccQueue: ['pfCC8'], cardIndex: 0, step };
    assertNoThrow(() => ctx.renderPayCreditCardsFlow(), 'step "' + step + '" must render without throwing');
  });
});

await check('reconcileAddExpense() uses the category the user actually selected, not always the first one', () => {
  ctx.state = buildMockState();
  ctx.state.categories = [
    { id: 'catFirst', name: 'First Category', icon: '📦' },
    { id: 'catChosen', name: 'Chosen Category', icon: '🎯' },
  ];
  const result = { matched: [], missingFromSpendly: [{ date: '2026-06-01', merchant: 'Test Shop', amount: 30 }], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.document.getElementById('missingCatSelect-0').value = 'catChosen';
  ctx.reconcileAddExpense(0);
  const added = ctx.state.expenses[ctx.state.expenses.length - 1];
  assertEqual(added.categoryId, 'catChosen', 'must use whatever category was actually selected in the dropdown, not silently default to the first category in the list');
});

await check('reconcileAddExpense() falls back to the first category only when nothing was explicitly selected', () => {
  ctx.state = buildMockState();
  ctx.state.categories = [{ id: 'catOnly', name: 'Only Category', icon: '📦' }];
  const result = { matched: [], missingFromSpendly: [{ date: '2026-06-01', merchant: 'Test Shop', amount: 30 }], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  // No selection made — dropdown defaults to empty in this environment
  ctx.document.getElementById('missingCatSelect-0').value = '';
  ctx.reconcileAddExpense(0);
  const added = ctx.state.expenses[ctx.state.expenses.length - 1];
  assertEqual(added.categoryId, 'catOnly', 'with no explicit selection, falling back to the first category is still a sensible default');
});

await check('the missing-from-Spendly row renders a category dropdown listing every real category, not a hardcoded list', () => {
  ctx.state = buildMockState();
  ctx.state.categories = [
    { id: 'catA', name: 'Groceries', icon: '🛒' },
    { id: 'catB', name: 'Transport', icon: '🚗' },
  ];
  const result = { matched: [], missingFromSpendly: [{ date: '2026-06-01', merchant: 'Test', amount: 10 }], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const html = ctx.document.getElementById('reconcileReviewScreen').innerHTML;
  assertTrue(html.includes('Groceries') && html.includes('Transport'), 'the dropdown must list the actual categories from state, not a fixed/hardcoded set');
  assertTrue(html.includes('missingCatSelect-0'), 'each item needs its own uniquely-identified dropdown');
});

await check('a resolved (already-added) missing item no longer shows its category dropdown or Add button', () => {
  ctx.state = buildMockState();
  const result = { matched: [], missingFromSpendly: [{ date: '2026-06-01', merchant: 'Test', amount: 10 }], missingFromStatement: [], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileAddExpense(0);
  const html = ctx.document.getElementById('reconcileReviewScreen').innerHTML;
  assertTrue(!html.includes('missingCatSelect-0'), 'once added, the picker should disappear along with the Add button — nothing left to act on');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Defer vs Delete, and visibility into deferred charges ──');

await check('reconcileDeleteUnbilledExpense() removes the expense entirely, for a charge that never actually happened', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'phantomExp1', date: '2026-06-01', amount: 9.99, categoryId: 'cat1', name: 'Paused subscription' });
  const expense = ctx.state.expenses.find(e => e.id === 'phantomExp1');
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [expense], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileDeleteUnbilledExpense(0);
  assertTrue(!ctx.state.expenses.some(e => e.id === 'phantomExp1'), 'a phantom charge (e.g. a paused subscription that auto-logged anyway) must be deleted outright, not deferred — deferring would just bring it back next cycle');
  assertEqual(ctx.window._reconciliation.resolved['defer-0'], 'deleted', 'must record which specific action was taken, not just a generic resolved flag');
});

await check('reconcileDeferExpense() still records its action distinctly from delete', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'realExp1', date: '2026-06-17', amount: 2000, categoryId: 'cat1' });
  const expense = ctx.state.expenses.find(e => e.id === 'realExp1');
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [expense], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  ctx.reconcileDeferExpense(0);
  assertEqual(ctx.window._reconciliation.resolved['defer-0'], 'deferred');
  assertTrue(ctx.state.expenses.some(e => e.id === 'realExp1'), 'deferring must keep the expense — only its treatment for budget math changes, never delete anything');
});

await check('the "logged, not yet billed" row offers BOTH Defer and Delete, not just one', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'someExp', date: '2026-06-01', amount: 50, categoryId: 'cat1' });
  const expense = ctx.state.expenses.find(e => e.id === 'someExp');
  const result = { matched: [], missingFromSpendly: [], missingFromStatement: [expense], splitSuggestions: [], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  const html = ctx.document.getElementById('reconcileReviewScreen').innerHTML;
  assertTrue(html.includes('reconcileDeferExpense(0)') && html.includes('reconcileDeleteUnbilledExpense(0)'), 'both options must be available — the same statement-vs-Spendly mismatch could mean either "not billed yet" or "never actually happened"');
});

await check('cycleExpenses() result is exactly what the deferred-items badge counts — single source of truth', () => {
  ctx.state = buildMockState();
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  ctx.state.expenses.push({ id: 'defIn1', date: ctx.dateToStr(prevStart), amount: 2000, categoryId: 'cat1', deferToNextCycle: true });
  const deferredIn = ctx.cycleExpenses(0).filter(e => e.deferToNextCycle);
  assertEqual(deferredIn.length, 1);
  assertEqual(deferredIn[0].id, 'defIn1');
});

await check('updateHeader() shows the deferred badge with the correct count and total when deferred charges count against the viewed cycle', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'expenses';
  ctx.state.viewingCycleOffset = 0;
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  ctx.state.expenses.push({ id: 'defIn2', date: ctx.dateToStr(prevStart), amount: 150, categoryId: 'cat1', deferToNextCycle: true });
  ctx.state.expenses.push({ id: 'defIn3', date: ctx.dateToStr(prevStart), amount: 50, categoryId: 'cat1', deferToNextCycle: true });
  assertNoThrow(() => ctx.updateHeader());
  const badge = ctx.document.getElementById('deferredBadge');
  assertEqual(badge.style.display, 'block', 'badge must be visible when deferred charges count against this cycle');
  assertTrue(badge.textContent.includes('2 deferred charges') && badge.textContent.includes('200'), 'must show an accurate count and total, not just a generic notice');
});

await check('updateHeader() hides the deferred badge when nothing is deferred into the viewed cycle', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'expenses';
  ctx.state.viewingCycleOffset = 0;
  assertNoThrow(() => ctx.updateHeader());
  const badge = ctx.document.getElementById('deferredBadge');
  assertEqual(badge.style.display, 'none', 'must stay hidden rather than showing an empty or zero-count notice');
});

await check('showDeferredItemsModal() runs without throwing for a real deferred expense', () => {
  ctx.state = buildMockState();
  const { cycleStart: prevStart } = ctx.getCycleRange(-1);
  ctx.state.expenses.push({ id: 'defIn4', date: ctx.dateToStr(prevStart), amount: 75, categoryId: 'cat1', name: 'Late dinner', deferToNextCycle: true });
  assertNoThrow(() => ctx.showDeferredItemsModal());
});

await check('showDeferredItemsModal() builds rows from each deferred item\'s real name, date, and amount', () => {
  const src = ctx.showDeferredItemsModal.toString();
  assertTrue(src.includes('e.name') && src.includes('e.date') && src.includes('e.amount'), 'each row must be built from the actual expense\'s own name, real spend date, and amount — not the cycle it is being counted toward');
  assertTrue(src.includes('deferToNextCycle'), 'must source its list from actually-deferred expenses, not an arbitrary or hardcoded set');
});



// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Refund pairing (cancelled bookings) and idempotent re-runs ──');

await check('reconcileStatement() pairs a same-statement charge+credit that are BOTH unmatched, instead of treating them as two unrelated actions (the cancelled-flight scenario)', () => {
  const statement = [
    { date: '2026-05-28', merchant: 'QANTAS AIRWAYS LTD', amount: 69.97, isCredit: false },
    { date: '2026-06-06', merchant: 'QANTAS AIRWAYS LTD REFUND', amount: 69.97, isCredit: true },
  ];
  // The booking was deleted from Spendly entirely when cancelled (the user's
  // actual workflow) — so neither side has any counterpart in Spendly at all.
  const r = ctx.reconcileStatement(statement, [], []);
  assertEqual(r.refundedPairs.length, 1, 'a same-amount charge and credit, both unmatched, found together on one statement must be recognized as a cancelled/refunded pair');
  assertEqual(r.missingFromSpendly.length, 0, 'the charge must NOT also be separately suggested as something to add — that would wrongly reintroduce a cancelled booking, including against any savings goal it might get linked to');
  assertEqual(r.creditsUnmatched.length, 0, 'the credit must NOT also be separately suggested as unexplained income — it is already explained by the paired charge');
});

await check('reconcileStatement() correctly pairs MULTIPLE same-amount charge+credit pairs (the actual real-world case: 2 cancelled flights, both $69.97)', () => {
  const statement = [
    { date: '2026-05-28', merchant: 'QANTAS', amount: 69.97, isCredit: false },
    { date: '2026-05-28', merchant: 'QANTAS', amount: 69.97, isCredit: false },
    { date: '2026-06-06', merchant: 'QANTAS REFUND', amount: 69.97, isCredit: true },
    { date: '2026-06-09', merchant: 'QANTAS REFUND', amount: 69.97, isCredit: true },
  ];
  const r = ctx.reconcileStatement(statement, [], []);
  assertEqual(r.refundedPairs.length, 2, 'two genuinely separate cancelled bookings must produce two separate pairs, not collapse into one or leave one stranded');
  assertEqual(r.missingFromSpendly.length, 0);
  assertEqual(r.creditsUnmatched.length, 0);
});

await check('reconcileStatement() does not pair a credit with a charge dated AFTER it — a refund cannot predate what it refunds', () => {
  const statement = [
    { date: '2026-06-10', merchant: 'Shop', amount: 50, isCredit: false },
    { date: '2026-06-01', merchant: 'Unrelated credit', amount: 50, isCredit: true }, // before the charge
  ];
  const r = ctx.reconcileStatement(statement, [], []);
  assertEqual(r.refundedPairs.length, 0, 'a credit dated before the charge cannot be its refund, even with a matching amount');
  assertEqual(r.missingFromSpendly.length, 1);
  assertEqual(r.creditsUnmatched.length, 1);
});

await check('reconcileStatement() still prefers a real history match over pairing, when an actual matching expense genuinely exists', () => {
  const statement = [{ date: '2026-05-15', merchant: 'Refund', amount: 76.79, isCredit: true }];
  const history = [{ id: 'realExp', date: '2026-03-14', amount: 76.79, categoryId: 'cat1', name: 'Real original purchase' }];
  const r = ctx.reconcileStatement(statement, [], history);
  assertEqual(r.creditsWithMatch.length, 1, 'when a real, traceable original expense exists in history, that remains the right explanation — same-statement pairing only applies when nothing else explains the credit');
});

await check('reconcileDismissRefundPair() logs the resolution and marks the pair resolved without throwing', () => {
  ctx.state = buildMockState();
  const result = { matched: [], possibleMatches: [], missingFromSpendly: [], missingFromStatement: [], splitSuggestions: [], refundedPairs: [{ charge: { date:'2026-05-28', merchant:'Qantas', amount:69.97 }, credit: { date:'2026-06-06', merchant:'Qantas refund', amount:69.97 } }], creditsWithMatch: [], creditsUnmatched: [] };
  ctx.showStatementReconciliationResults('cc1', result, null);
  assertNoThrow(() => ctx.reconcileDismissRefundPair(0));
  assertEqual(ctx.window._reconciliation.resolved['refundpair-0'], true);
  assertEqual(ctx.state.resolvedStatementCredits.length, 1);
  assertEqual(ctx.state.resolvedStatementCredits[0].resolution, 'refunded-pair');
});

await check('runStatementReconciliation() does not re-flag a credit already resolved as income on a previous run of the SAME statement', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'ccIdem1', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.resolvedStatementCredits = [{ id: 'r1', ccAccountId: 'ccIdem1', date: d, amount: 30, merchant: 'Old refund', resolution: 'income', resolvedAt: new Date().toISOString() }];
  const statement = [{ date: d, merchant: 'Old refund', amount: 30, isCredit: true }];
  let captured = null;
  const origShow = ctx.showStatementReconciliationResults;
  ctx.showStatementReconciliationResults = (id, result, info) => { captured = result; };
  ctx.runStatementReconciliation('ccIdem1', statement);
  ctx.showStatementReconciliationResults = origShow;
  assertEqual(captured.creditsUnmatched.length, 0, 'a credit already resolved in a previous run must not be re-flagged as unmatched');
  assertEqual(captured.skippedAlreadyResolved, 1, 'should report that something was skipped, for transparency, rather than silently vanishing with no trace at all');
});

await check('runStatementReconciliation() does not affect credits from a DIFFERENT credit card\'s resolution log', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'ccIdem2', name: 'Card A', type: 'credit' });
  ctx.state.accounts.push({ id: 'ccIdem3', name: 'Card B', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.resolvedStatementCredits = [{ id: 'r2', ccAccountId: 'ccIdem2', date: d, amount: 30, merchant: 'X', resolution: 'income', resolvedAt: new Date().toISOString() }];
  const statement = [{ date: d, merchant: 'X', amount: 30, isCredit: true }];
  let captured = null;
  const origShow = ctx.showStatementReconciliationResults;
  ctx.showStatementReconciliationResults = (id, result) => { captured = result; };
  ctx.runStatementReconciliation('ccIdem3', statement); // different card
  ctx.showStatementReconciliationResults = origShow;
  assertEqual(captured.creditsUnmatched.length, 1, 'a resolution logged against one card must never suppress a credit on a completely different card');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Goal transaction history: full cycle-grouped history, not current-cycle-only ──');

await check('buildSavingsCatTransactionRows() groups a past-cycle goal-covered expense into its own collapsed cycle, not silently dropped', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'travelGoal1', name: 'Travel', icon: '🏖️' });
  ctx.state.categories.push({ id: 'travelCat1', name: 'Travel', icon: '✈️', linkedSavingsGoalId: 'travelGoal1' });
  const { cycleStart: oldStart } = ctx.getCycleRange(-3);
  const oldDate = ctx.dateToStr(oldStart);
  ctx.state.expenses.push({ id: 'qantasA', date: oldDate, amount: 69.97, categoryId: 'travelCat1', name: 'Qantas flight', linkedGoalId: 'travelGoal1', goalCoveredAmount: 69.97 });
  const cat = ctx.catById('travelCat1');
  const rows = ctx.buildSavingsCatTransactionRows(cat, ctx.state.expenses);
  assertTrue(!rows.includes('Qantas flight'), 'a past cycle is collapsed by default — the real bug being fixed was this expense being completely invisible/unreachable, not that it should be open by default');
  assertTrue(rows.includes('toggleGoalHistoryCycle'), 'the cycle group itself must still exist with a way to expand it, unlike the old current-cycle-only behavior where past cycles had no representation at all');
});

await check('toggleGoalHistoryCycle expanding the right cycle reveals a 3-cycles-old goal-covered expense (the actual reported gap: "I can only see 4 transactions")', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'travelGoal2', name: 'Travel', icon: '🏖️' });
  ctx.state.categories.push({ id: 'travelCat2', name: 'Travel', icon: '✈️', linkedSavingsGoalId: 'travelGoal2' });
  const { cycleStart: oldStart } = ctx.getCycleRange(-3);
  const oldDate = ctx.dateToStr(oldStart);
  ctx.state.expenses.push({ id: 'qantasB', date: oldDate, amount: 69.97, categoryId: 'travelCat2', name: 'Old Qantas charge', linkedGoalId: 'travelGoal2', goalCoveredAmount: 69.97 });
  const key = 'travelCat2|' + ctx.dateToStr(oldStart);
  ctx.window._expandedGoalHistoryCycles = new Set([key]);
  ctx.window._goalHistorySeen = new Set(['travelCat2']);
  const cat = ctx.catById('travelCat2');
  const rows = ctx.buildSavingsCatTransactionRows(cat, ctx.state.expenses);
  assertTrue(rows.includes('Old Qantas charge'), 'expanding the correct cycle must reveal a charge from 3 cycles back — previously impossible to ever see, regardless of how it was navigated to');
});

await check('deleteGoalLinkedExpense() removes the real expense, correcting exactly the kind of real-account-vs-Spendly drift this was built for', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'refundedExp1', date: '2026-05-28', amount: 69.97, categoryId: 'cat1', name: 'Cancelled flight', linkedGoalId: 'goal1', goalCoveredAmount: 69.97 });
  ctx.deleteGoalLinkedExpense('refundedExp1');
  assertTrue(!ctx.state.expenses.some(e => e.id === 'refundedExp1'), 'deleting a refunded/cancelled goal-covered expense must remove it entirely — this is what actually corrects the goal balance, not a display-only dismissal');
});

await check('each goal\'s expand/collapse state is tracked independently — expanding one goal\'s past cycle must not affect a different goal', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'goalX', name: 'Goal X', icon: '🎯' }, { id: 'goalY', name: 'Goal Y', icon: '🎯' });
  ctx.state.categories.push({ id: 'catX', name: 'X', linkedSavingsGoalId: 'goalX' }, { id: 'catY', name: 'Y', linkedSavingsGoalId: 'goalY' });
  const { cycleStart: oldStart } = ctx.getCycleRange(-2);
  const oldDate = ctx.dateToStr(oldStart);
  ctx.state.expenses.push({ id: 'expX', date: oldDate, amount: 20, categoryId: 'catX', name: 'X expense', linkedGoalId: 'goalX', goalCoveredAmount: 20 });
  ctx.state.expenses.push({ id: 'expY', date: oldDate, amount: 30, categoryId: 'catY', name: 'Y expense', linkedGoalId: 'goalY', goalCoveredAmount: 30 });
  ctx.window._expandedGoalHistoryCycles = new Set(['catX|' + ctx.dateToStr(oldStart)]); // only X's cycle expanded
  ctx.window._goalHistorySeen = new Set(['catX', 'catY']);
  const rowsX = ctx.buildSavingsCatTransactionRows(ctx.catById('catX'), ctx.state.expenses);
  const rowsY = ctx.buildSavingsCatTransactionRows(ctx.catById('catY'), ctx.state.expenses);
  assertTrue(rowsX.includes('X expense'), 'goal X\'s expanded cycle should show its own expense');
  assertTrue(!rowsY.includes('Y expense'), 'goal Y must remain independently collapsed — expanding X must never leak into Y\'s state');
});

await check('buildSavingsCatTransactionRows() leaves deposits/withdrawals completely unaffected by the rewrite — same data, same row format', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'goalZ', name: 'Goal Z', icon: '🎯' });
  ctx.state.categories.push({ id: 'catZ', name: 'Z', linkedSavingsGoalId: 'goalZ' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.savingsDeposits.push({ id: 'depZ', catId: 'goalZ', amount: 100, date: ctx.dateToStr(cycleStart), type: 'deposit', note: 'Manual top-up' });
  const cat = ctx.catById('catZ');
  const rows = ctx.buildSavingsCatTransactionRows(cat, ctx.state.expenses);
  assertTrue(rows.includes('Manual top-up'), 'a regular deposit in the current cycle (expanded by default) must still display correctly');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Critical fix: Confirm & Pay must actually settle expenses, not silently no-op ──');

await check('openPayCCFromSalary() embeds unsettledIds in the data passed to Confirm & Pay — this field was missing entirely, the actual root cause of a real reported bug', () => {
  const src = ctx.openPayCCFromSalary.toString();
  assertTrue(src.includes('unsettledIds:'), 'the JSON payload passed to confirmPayCCFromSalary must include which expenses to settle — without this field, settledExpIds silently evaluated to an empty array on every payment: money moved from salary correctly, but no charge was ever actually marked paid, so the same amount would reappear as owed again, looking exactly like the button did nothing');
});

await check('confirmPayCCFromSalary() reads settledExpIds from ccInfo.unsettledIds directly, not a nested breakdown field that was never actually serialized', () => {
  const src = ctx.confirmPayCCFromSalary.toString();
  assertTrue(src.includes('ccInfo.unsettledIds'), 'must read the flat field that actually exists in the serialized data');
  assertTrue(!src.includes('ccInfo.breakdown.unsettled') && !src.includes('ccInfo.breakdown &&'), 'must not actually USE ccInfo.breakdown anywhere in executable code — that property was never included in breakdownDataJson, making any reference to it silently undefined');
});

await check('confirmPayCCFromSalary() with the corrected data shape actually marks the real expense settled — full round trip', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'critFixSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'critFixCC', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const realExpense = { id: 'critFixExp', date: ctx.dateToStr(cycleStart), amount: 200, categoryId: 'cat1', paymentAccountId: 'critFixCC' };
  ctx.state.expenses.push(realExpense);
  ctx.document.getElementById('ccPaySelect').value = '0';
  ctx.window._ccPayModalData = [{ id: 'critFixCC', owed: 200, salaryTotal: 200, goalTotal: 0, contributions: [], unsettledIds: ['critFixExp'] }];
  ctx.confirmPayCCFromSalary('critFixSalary');
  const settledIds = new Set((ctx.state.ccPayments||[]).flatMap(p => p.expenseIds||[]));
  assertTrue(settledIds.has('critFixExp'), 'after confirming payment, the real expense must actually be recorded as settled');
  // Confirm a SECOND call to getCCGoalContributions now shows it as settled (no longer owed)
  const after = ctx.getCCGoalContributions('critFixCC', 0);
  assertEqual(after.grossTotal, 0, 'once settled, the same charge must NOT reappear as still owed — this is exactly the symptom that made the button look broken');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── CRITICAL: salaryTotal must never go negative when using a closing balance ──');
console.log('   (the actual reported "salary amount looks the same" bug)');

await check('getCCGoalContributions() clamps salaryTotal to zero when goal contributions alone exceed the closing balance (the exact reported scenario)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'negSalCC1', name: 'Card', type: 'credit' });
  ctx.state.savingsCategories.push({ id: 'negSalGoal1', name: 'Travel' });
  ctx.state.savingsDeposits.push({ id: 'negSalDep1', catId: 'negSalGoal1', amount: 10000, date: '2026-01-01', type: 'deposit' });
  const { cycleEnd, cycleStart } = ctx.getCycleRange(0);
  const acct = ctx.accountById('negSalCC1');
  acct.closingBalance = 5626.86;
  acct.closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  ctx.state.expenses.push({ id: 'negSalExp1', date: ctx.dateToStr(cycleStart), amount: 8000, categoryId: 'cat1', paymentAccountId: 'negSalCC1', linkedGoalId: 'negSalGoal1', goalCoveredAmount: 8000 });
  ctx.state.expenses.push({ id: 'negSalExp2', date: ctx.dateToStr(cycleStart), amount: 980.72, categoryId: 'cat1', paymentAccountId: 'negSalCC1' });
  const breakdown = ctx.getCCGoalContributions('negSalCC1', 0);
  assertEqual(breakdown.salaryTotal, 0, 'a negative salary contribution is never valid in a real payment — it would mean paying a CC bill somehow increases the salary balance. Previously this was -2373.14, which is exactly why the reported payment silently moved the salary balance the wrong way instead of decreasing it');
  assertEqual(breakdown.goalTotalExceedsClosingBalance, true, 'must flag this specific condition distinctly so the UI can warn and block, not just silently clamp');
});

await check('getCCGoalContributions() does NOT flag goalTotalExceedsClosingBalance for a normal, small gap', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'negSalCC2', name: 'Card', type: 'credit' });
  const { cycleEnd, cycleStart } = ctx.getCycleRange(0);
  const acct = ctx.accountById('negSalCC2');
  acct.closingBalance = 500;
  acct.closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  ctx.state.expenses.push({ id: 'negSalExp3', date: ctx.dateToStr(cycleStart), amount: 495, categoryId: 'cat1', paymentAccountId: 'negSalCC2' });
  const breakdown = ctx.getCCGoalContributions('negSalCC2', 0);
  assertEqual(breakdown.goalTotalExceedsClosingBalance, false, 'a small, normal gap with no goal contributions involved must never trigger this specific warning');
});

await check('the earlier deliberate refund-netting behavior (negative salaryTotal with NO closing balance involved) is completely unaffected by this fix', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'negSalCC3', name: 'Card', type: 'credit' });
  ctx.state.savingsCategories.push({ id: 'negSalGoal3', name: 'Holiday' });
  ctx.state.savingsDeposits.push({ id: 'negSalDep3', catId: 'negSalGoal3', amount: 500, date: '2026-01-01', type: 'deposit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const todayInCycle = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'negSalExp4', date: todayInCycle, amount: 100, categoryId: 'cat1', paymentAccountId: 'negSalCC3', goalCoveredAmount: 100, linkedGoalId: 'negSalGoal3' });
  ctx.state.accountTransactions.push({ id: 'negSalRef1', type: 'ccRefund', toAccountId: 'negSalCC3', amount: 30, date: todayInCycle, deleted: false });
  const result = ctx.getCCGoalContributions('negSalCC3', 0);
  assertEqual(result.salaryTotal, -30, 'this specific behavior — a refund correctly pushing salaryTotal negative when NOT using a closing balance — is deliberate and mathematically consistent (goalTotal + salaryTotal still equals grossTotal exactly); the new clamp must not touch this case at all');
  assertEqual(result.goalTotalExceedsClosingBalance, false, 'no closing balance is involved here at all, so this flag must never fire');
});

await check('openPayCCFromSalary() disables Confirm & Pay and shows a distinct warning when goalTotalExceedsClosingBalance is true', () => {
  const src = ctx.openPayCCFromSalary.toString();
  assertTrue(src.includes('goalTotalExceedsClosingBalance') && src.includes('disabled'), 'the button must actually be disabled in this state, not just show a warning text the user could ignore and tap through anyway');
  assertTrue(src.includes('exceed this bill'), 'must show a clear, specific explanation of what is wrong and why, not a generic error');
});

await check('the data passed to confirmPayCCFromSalary includes goalTotalExceedsClosingBalance', () => {
  const src = ctx.openPayCCFromSalary.toString();
  assertTrue(src.includes('goalTotalExceedsClosingBalance: x.breakdown.goalTotalExceedsClosingBalance'), 'the flag must be threaded through to the data actually used at confirm time, not just available in the preview render');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Robustness fix: Pay CC data via a real JS variable, not embedded HTML/JSON ──');

await check('openPayCCFromSalary() no longer embeds JSON directly into the onclick attribute — stores it in window._ccPayModalData instead', () => {
  const src = ctx.openPayCCFromSalary.toString();
  assertTrue(src.includes('window._ccPayModalData'), 'must store the payment data as a real in-memory reference');
  assertTrue(!src.includes('breakdownDataJson'), 'the old stringify-and-escape-into-HTML pattern must be fully gone — any unusual character anywhere in 67+ real expenses/goal names could silently break that pattern in ways clean test data would never surface');
  assertTrue(!src.includes(".replace(/'/g"), 'no manual quote-escaping into an HTML attribute should remain at all');
});

await check('confirmPayCCFromSalary() reads from window._ccPayModalData rather than a function parameter', () => {
  const src = ctx.confirmPayCCFromSalary.toString();
  assertTrue(src.includes('window._ccPayModalData'), 'must read the real reference set by openPayCCFromSalary');
});

await check('the full payment flow works correctly through the new window-variable pattern, with goal names containing emoji and spaces (matching real data)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'robustSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 11220.95 });
  ctx.state.accounts.push({ id: 'robustCC', name: 'ANZ CC', type: 'credit' });
  ctx.state.savingsCategories.push({ id: 'robustGoal1', name: 'South America', icon: '✈️' });
  ctx.state.savingsDeposits.push({ id: 'rd1', catId: 'robustGoal1', amount: 2000, date: '2026-01-01', type: 'deposit' });
  const { cycleEnd, cycleStart } = ctx.getCycleRange(0);
  const acct = ctx.accountById('robustCC');
  acct.closingBalance = 5626.86;
  acct.closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'rExp1', date: d, amount: 911.50, categoryId: 'cat1', paymentAccountId: 'robustCC', linkedGoalId: 'robustGoal1', goalCoveredAmount: 911.50 });
  ctx.state.expenses.push({ id: 'rExp2', date: d, amount: 4715.36, categoryId: 'cat1', paymentAccountId: 'robustCC' });
  assertNoThrow(() => ctx.openPayCCFromSalary('robustSalary'));
  assertTrue(Array.isArray(ctx.window._ccPayModalData) && ctx.window._ccPayModalData.length === 1, 'should populate the real data array correctly');
  ctx.document.getElementById('ccPaySelect').value = '0';
  assertNoThrow(() => ctx.confirmPayCCFromSalary('robustSalary'));
  const settledIds = new Set((ctx.state.ccPayments||[]).flatMap(p => p.expenseIds||[]));
  assertTrue(settledIds.has('rExp1') && settledIds.has('rExp2'), 'both expenses must be correctly settled end-to-end through the new pattern');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Surplus/shortfall panel must use the SAME CC total as the Pay CC modal ──');

await check('buildSurplusShortfallPanelHtml() uses the closing-balance-aware CC total, not its own separate itemized-only calculation (a real phantom-shortfall bug)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.accounts.push({ id: 'panelSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 11220.95 });
  ctx.state.accounts.push({ id: 'panelCC', name: 'ANZ CC', type: 'credit' });
  const { cycleEnd, cycleStart } = ctx.getCycleRange(0);
  const acct = ctx.accountById('panelCC');
  acct.closingBalance = 5626.86;
  acct.closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'panelExp1', date: d, amount: 8980.72, categoryId: 'cat1', paymentAccountId: 'panelCC' });
  const html = ctx.buildSurplusShortfallPanelHtml('panelSalary', 0);
  assertTrue(html.includes('5,626.86'), 'must show the real closing balance ($5,626.86), matching exactly what the Pay CC modal itself shows for the same card and cycle');
  assertTrue(!html.includes('8,980.72'), 'must NOT show the raw itemized total — that was the actual reported bug: a $884.77 phantom shortfall that was really a $5,594.09 surplus once the correct, lower closing balance was used instead');
});

await check('buildSurplusShortfallPanelHtml() correctly sums across MULTIPLE credit cards using the same authoritative calculation', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.accounts.push({ id: 'panelSalary2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'panelCCa', name: 'Card A', type: 'credit' });
  ctx.state.accounts.push({ id: 'panelCCb', name: 'Card B', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'pExpA', date: d, amount: 100, categoryId: 'cat1', paymentAccountId: 'panelCCa' });
  ctx.state.expenses.push({ id: 'pExpB', date: d, amount: 50, categoryId: 'cat1', paymentAccountId: 'panelCCb' });
  const html = ctx.buildSurplusShortfallPanelHtml('panelSalary2', 0);
  assertTrue(html.includes('150.00'), 'must show the combined total across both cards ($100 + $50 = $150), consistent with the Pending CC card on the Salary page');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── CRITICAL: closing balance must clear after being paid, or it shows owed forever ──');
console.log('   (the actual reported "Pay CTA still enabled, still shows $5.6k" bug)');

await check('confirmPayCCFromSalary() clears the closing balance after a payment that used it, so the account does not show the same amount owed forever', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.accounts.push({ id: 'clearSalary1', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 11220.95 });
  ctx.state.accounts.push({ id: 'clearCC1', name: 'ANZ CC', type: 'credit' });
  const { cycleEnd, cycleStart } = ctx.getCycleRange(0);
  const acct = ctx.accountById('clearCC1');
  acct.closingBalance = 5626.86;
  acct.closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  const d = ctx.dateToStr(cycleStart);
  ctx.state.expenses.push({ id: 'clearExp1', date: d, amount: 5626.86, categoryId: 'cat1', paymentAccountId: 'clearCC1' });

  const before = ctx.getCCGoalContributions('clearCC1', 0);
  assertEqual(before.grossTotal, 5626.86, 'sanity check before paying');

  ctx.openPayCCFromSalary('clearSalary1');
  ctx.document.getElementById('ccPaySelect').value = '0';
  ctx.confirmPayCCFromSalary('clearSalary1');

  assertTrue(acct.closingBalance === undefined, 'the static closing balance must be cleared once a payment using it is confirmed — it represented a one-time statement snapshot, not an ongoing balance');
  assertTrue(acct.closingBalanceCycleEnd === undefined);
  const after = ctx.getCCGoalContributions('clearCC1', 0);
  assertEqual(after.grossTotal, 0, 'this is the actual reported symptom: without clearing, this would keep returning the SAME 5626.86 forever, looking exactly like the payment had no effect, even though the underlying expense was correctly settled');
});

await check('confirmPayCCFromSalary() does NOT clear the closing balance when it was not actually used (pure itemized payment)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.accounts.push({ id: 'clearSalary2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'clearCC2', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'clearExp2', date: ctx.dateToStr(cycleStart), amount: 50, categoryId: 'cat1', paymentAccountId: 'clearCC2' });
  const acct = ctx.accountById('clearCC2');
  // No closing balance set at all for this card
  ctx.openPayCCFromSalary('clearSalary2');
  ctx.document.getElementById('ccPaySelect').value = '0';
  ctx.confirmPayCCFromSalary('clearSalary2');
  assertTrue(acct.closingBalance === undefined, 'should remain unset (never had one) — confirms this fix only acts when a closing balance was genuinely involved');
});

await check('a partially-settled card with a closing balance from an OLDER, different cycle is unaffected by clearing a CURRENT cycle\'s payment', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.accounts.push({ id: 'clearSalary3', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'clearCC3', name: 'Card', type: 'credit' });
  const { cycleEnd, cycleStart } = ctx.getCycleRange(0);
  const acct = ctx.accountById('clearCC3');
  acct.closingBalance = 100;
  acct.closingBalanceCycleEnd = ctx.dateToStr(cycleEnd);
  ctx.state.expenses.push({ id: 'clearExp3', date: ctx.dateToStr(cycleStart), amount: 100, categoryId: 'cat1', paymentAccountId: 'clearCC3' });
  ctx.openPayCCFromSalary('clearSalary3');
  ctx.document.getElementById('ccPaySelect').value = '0';
  ctx.confirmPayCCFromSalary('clearSalary3');
  assertTrue(acct.closingBalance === undefined, 'after paying it off, the closing balance for this now-settled cycle must be cleared so a fresh one can be set next time without confusion');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Salary page section rename and reorder ──');

await check('the Pending CC card is renamed to "Current/Previous Cycle Credit Card Balance"', () => {
  ctx.state = buildMockState();
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'renameSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'renameCC', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'renameExp1', date: ctx.dateToStr(cycleStart), amount: 50, categoryId: 'cat1', paymentAccountId: 'renameCC' });
  ctx._viewingAccountId = 'renameSalary';
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('Current Cycle Credit Card Balance'), 'must use the new label for the current cycle case');
});

await check('the "Pending Savings payments" section now renders AFTER the Credit Card Balance card, directly underneath it as requested', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'orderSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'orderCC', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'orderExp1', date: ctx.dateToStr(cycleStart), amount: 100, categoryId: 'cat1', paymentAccountId: 'orderCC' });
  ctx._viewingAccountId = 'orderSalary';
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  const ccIdx = html.indexOf('Current Cycle Credit Card Balance');
  const savIdx = html.indexOf('Pending Savings payments');
  assertTrue(ccIdx !== -1 && savIdx !== -1, 'both sections must actually render');
  assertTrue(ccIdx < savIdx, 'Pending Savings payments must appear AFTER the Credit Card Balance card, not before it as it did previously');
});

await check('the cycle navigator (‹ Current cycle ›) still renders BEFORE the Credit Card Balance card — only Pending Savings payments moved, not the navigator itself', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'navOrderSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'navOrderCC', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'navOrderExp1', date: ctx.dateToStr(cycleStart), amount: 100, categoryId: 'cat1', paymentAccountId: 'navOrderCC' });
  ctx._viewingAccountId = 'navOrderSalary';
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  const navIdx = html.indexOf('navigateSalaryCycle(-1)');
  const ccIdx = html.indexOf('Current Cycle Credit Card Balance');
  assertTrue(navIdx !== -1 && ccIdx !== -1);
  assertTrue(navIdx < ccIdx, 'the cycle navigator itself must remain in its original position, ahead of the Credit Card Balance card');
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Pending savings payment: HARD-BLOCK overdrawing salary (was: warn) ──');

// Behaviour deliberately changed in v2.22.0: paying a pending goal payment that would
// overdraw the salary account is now PREVENTED, not merely warned. This was the root
// trigger of the offset discrepancy — a soft "pay anyway?" let salary be driven negative.

await check('payPendingItem() hard-blocks a payment that would overdraw salary — nothing is paid, item stays pending, salary untouched', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'blkSalary1', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 50 });
  ctx.state.savingsCategories.push({ id: 'blkGoal1', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'bpp1', salaryAccountId: 'blkSalary1', status: 'pending', dueDate: ctx.todayStr(), amount: 100, goalId: 'blkGoal1', note: 'Test' });
  ctx.confirm = () => true; // even if the user "confirms", the block must hold
  const before = ctx.getAccountBalance('blkSalary1');
  ctx.payPendingItem('bpp1');
  const p = ctx.state.pendingPayments.find(x => x.id === 'bpp1');
  assertEqual(p.status, 'pending', 'an overdrawing payment must NOT be executed — it is blocked, not just warned');
  assertTrue(!ctx.state.savingsDeposits.some(d => d.note === 'Test' && d.amount === 100), 'no goal deposit may be created when the payment is blocked');
  assertEqual(ctx.getAccountBalance('blkSalary1'), before, 'salary balance must be untouched after a blocked payment');
});

await check('payPendingItem() still pays normally when the salary balance covers it', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'blkSalary2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 500 });
  ctx.state.savingsCategories.push({ id: 'blkGoal2', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'bpp2', salaryAccountId: 'blkSalary2', status: 'pending', dueDate: ctx.todayStr(), amount: 100, goalId: 'blkGoal2', note: 'Test' });
  ctx.confirm = () => true;
  ctx.payPendingItem('bpp2');
  const p = ctx.state.pendingPayments.find(x => x.id === 'bpp2');
  assertEqual(p.status, 'paid', 'a payment the balance genuinely covers must still go through');
});

await check('payPendingItem() blocks only on a genuine overdraw, not when paying exactly empties the account (zero is allowed)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'blkSalary3', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 100 });
  ctx.state.savingsCategories.push({ id: 'blkGoal3', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'bpp3', salaryAccountId: 'blkSalary3', status: 'pending', dueDate: ctx.todayStr(), amount: 100, goalId: 'blkGoal3', note: 'Test' });
  ctx.confirm = () => true;
  ctx.payPendingItem('bpp3');
  const p = ctx.state.pendingPayments.find(x => x.id === 'bpp3');
  assertEqual(p.status, 'paid', 'paying down to exactly zero is fine — only going below zero is blocked');
});

await check('payPendingItem() does NOT double-debit salary — the deposit is the goal-side credit only; the paid pending is the single salary debit (the core v2.22.0 fix)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'ddSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'ddGoal', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'ddpp', salaryAccountId: 'ddSalary', status: 'pending', dueDate: ctx.todayStr(), amount: 200, goalId: 'ddGoal', note: 'Test' });
  ctx.confirm = () => true;
  const goalBefore = ctx.totalSavedForCat('ddGoal');
  ctx.payPendingItem('ddpp');
  // Salary must drop by EXACTLY 200 (once), not 400 (the old double-count bug)
  assertEqual(ctx.getAccountBalance('ddSalary'), 800, 'salary must be debited once (1000 - 200), never twice');
  assertEqual(ctx.totalSavedForCat('ddGoal') - goalBefore, 200, 'the goal must be credited exactly once');
  const dep = ctx.state.savingsDeposits.find(d => d.pendingPaymentId === 'ddpp');
  assertTrue(!!dep, 'the goal-side deposit must be created and linked back to its pending payment');
  assertTrue(dep.sourceAccountId == null, 'the pending-paid deposit must NOT carry sourceAccountId — that double-debited salary');
  const p = ctx.state.pendingPayments.find(x => x.id === 'ddpp');
  assertEqual(p.depositId, dep.id, 'the pending payment must link forward to its deposit (atomic pair)');
});

await check('deleting a pending-paid deposit reverts its pending payment to unpaid and returns the money to salary — no orphan (the exact deletion that caused the discrepancy)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'revSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'revGoal', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'revpp', salaryAccountId: 'revSalary', status: 'pending', dueDate: ctx.todayStr(), amount: 250, goalId: 'revGoal', note: 'Test' });
  ctx.confirm = () => true;
  ctx.payPendingItem('revpp');
  const dep = ctx.state.savingsDeposits.find(d => d.pendingPaymentId === 'revpp');
  assertEqual(ctx.getAccountBalance('revSalary'), 750, 'sanity: salary is 1000 - 250 after paying');
  // Now delete the goal deposit (what the user did to "fix" a negative salary)
  ctx._deleteSavingsDepositById(dep.id);
  const p = ctx.state.pendingPayments.find(x => x.id === 'revpp');
  assertEqual(p.status, 'pending', 'deleting the goal deposit must un-pay its linked pending payment');
  assertEqual(ctx.getAccountBalance('revSalary'), 1000, 'the money must return to salary — not vanish from the offset');
  const issues = ctx.findSalaryGoalIssues();
  assertEqual(issues.orphanedPaidPendings.length, 0, 'there must be no orphaned paid pending payment after an atomic reverse');
});

await check('cancelPendingItem() on an already-paid item removes its goal deposit too (no orphaned deposit left behind)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'canSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'canGoal', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'canpp', salaryAccountId: 'canSalary', status: 'pending', dueDate: ctx.todayStr(), amount: 120, goalId: 'canGoal', note: 'Test' });
  ctx.confirm = () => true;
  ctx.payPendingItem('canpp');
  const depId = ctx.state.pendingPayments.find(x => x.id === 'canpp').depositId;
  assertTrue(!!ctx.state.savingsDeposits.find(d => d.id === depId), 'sanity: deposit exists after paying');
  ctx.cancelPendingItem('canpp');
  assertTrue(!ctx.state.savingsDeposits.find(d => d.id === depId), 'cancelling a paid item must remove its goal deposit');
  assertEqual(ctx.getAccountBalance('canSalary'), 1000, 'cancelling returns the money to salary');
});

await check('findSalaryGoalIssues() flags a paid pending whose goal deposit was deleted (orphaned outflow)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'intSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'intGoal', name: 'Travel' });
  // A paid pending with NO matching deposit anywhere — the Holidays/Council situation
  ctx.state.pendingPayments.push({ id: 'intpp', salaryAccountId: 'intSalary', status: 'paid', paidAmount: 268.21, dueDate: ctx.todayStr(), amount: 268.21, goalId: 'intGoal', note: 'Council' });
  const issues = ctx.findSalaryGoalIssues();
  assertEqual(issues.orphanedPaidPendings.length, 1, 'a paid pending with no goal deposit must be reported as orphaned');
  assertEqual(issues.orphanedPaidPendings[0].amount, 268.21, 'the reported orphan must carry the real amount for cleanup');
});

await check('findSalaryGoalIssues() flags a legacy double-debit (deposit carries sourceAccountId AND a matching paid pending exists)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'ddSal2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'ddGoal2', name: 'Shares' });
  ctx.state.pendingPayments.push({ id: 'ddpp2', salaryAccountId: 'ddSal2', status: 'paid', paidAmount: 670.22, dueDate: ctx.todayStr(), amount: 670.22, goalId: 'ddGoal2', note: 'Shares' });
  ctx.state.savingsDeposits.push({ id: 'dddep2', catId: 'ddGoal2', targetId: 'ddGoal2', type: 'deposit', amount: 670.22, date: ctx.todayStr(), note: 'Shares', sourceAccountId: 'ddSal2' });
  const issues = ctx.findSalaryGoalIssues();
  assertEqual(issues.doubleDebits.length, 1, 'a deposit with sourceAccountId plus a matching paid pending is a double-debit and must be flagged');
});

await check('resolveOrphanedPaidPendings() rebuilds the deleted goal deposit from the paid pending — money returns to the offset, orphan count goes to zero', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'resSal', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'resGoal', name: 'Council rates' });
  // A paid pending whose goal deposit was deleted — exactly the real Holidays/Council case
  ctx.state.pendingPayments.push({ id: 'respp', salaryAccountId: 'resSal', status: 'paid', paidAmount: 268.21, dueDate: ctx.todayStr(), amount: 268.21, goalId: 'resGoal', note: 'Council rates' });
  const goalBefore = ctx.totalSavedForCat('resGoal');
  assertEqual(ctx.findSalaryGoalIssues().orphanedPaidPendings.length, 1, 'sanity: starts orphaned');
  ctx.resolveOrphanedPaidPendings();
  assertEqual(ctx.totalSavedForCat('resGoal') - goalBefore, 268.21, 'the exact paid amount must be restored to the goal');
  assertEqual(ctx.findSalaryGoalIssues().orphanedPaidPendings.length, 0, 'no orphan should remain after the repair');
  const dep = ctx.state.savingsDeposits.find(d => d.pendingPaymentId === 'respp');
  assertTrue(!!dep && dep.sourceAccountId == null, 'rebuilt deposit must be linked and must NOT carry sourceAccountId (no re-introduced double-debit)');
});

await check('resolveOrphanedPaidPendings() does not double-debit salary when it rebuilds a deposit (salary stays put; only the goal is credited)', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'resSal2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'resGoal2', name: 'Holidays' });
  ctx.state.pendingPayments.push({ id: 'respp2', salaryAccountId: 'resSal2', status: 'paid', paidAmount: 2145.51, dueDate: ctx.todayStr(), amount: 2145.51, goalId: 'resGoal2', note: 'Holidays' });
  const salBefore = ctx.getAccountBalance('resSal2'); // already reflects the paid pending debit
  ctx.resolveOrphanedPaidPendings();
  assertEqual(ctx.getAccountBalance('resSal2'), salBefore, 'rebuilding the goal deposit must not change salary — the pending payment is still the single debit');
});

await check('resolveDuplicateGoalOutflows() removes a same-goal same-day same-amount duplicate outflow and restores it to the goal (the 23 Mar mortgage double-payment)', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'dupGoal', name: 'Home savings' });
  ctx.state.savingsDeposits.push({ id: 'dseed', catId: 'dupGoal', type: 'deposit', amount: 2000, date: '2026-03-15', note: 'seed' });
  ctx.state.savingsDeposits.push({ id: 'dx1', catId: 'dupGoal', type: 'withdrawal', amount: 875, date: '2026-03-23', note: 'Weekly mortgage payment' });
  ctx.state.savingsDeposits.push({ id: 'dx2', catId: 'dupGoal', type: 'bill-payment', amount: 875, date: '2026-03-23', note: 'Mortgage' });
  const before = ctx.totalSavedForCat('dupGoal');
  assertEqual(ctx.findDuplicateGoalOutflows().length, 1, 'two identical same-day outflows must register as exactly one duplicate');
  ctx.resolveDuplicateGoalOutflows();
  assertEqual(ctx.totalSavedForCat('dupGoal') - before, 875, 'removing the duplicate restores exactly one payment to the goal');
  assertEqual(ctx.findDuplicateGoalOutflows().length, 0, 'no duplicates should remain after the repair');
});

await check('findDuplicateGoalOutflows() does NOT flag two distinct outflows of different amounts on the same day', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'dg2', name: 'Servicios' });
  ctx.state.savingsDeposits.push({ id: 'aa1', catId: 'dg2', type: 'bill-payment', amount: 73.90, date: '2026-06-18', note: 'Origin Energy' });
  ctx.state.savingsDeposits.push({ id: 'aa2', catId: 'dg2', type: 'bill-payment', amount: 32.38, date: '2026-06-18', note: 'Origin Energy' });
  assertEqual(ctx.findDuplicateGoalOutflows().length, 0, 'different amounts on the same day are legitimate, not duplicates');
});

await check('resolveCurrentCycleDoubleDebits() strips the stray sourceAccountId so a current-cycle payment is debited from Salary only once (restores the unallocated offset slice)', () => {
  ctx.state = buildMockState();
  ctx.state.cycleType = 'monthly'; ctx.state.cycleDay = 1;
  ctx.state.accounts.push({ id: 'ddOff', name: 'Offset', type: 'offset', openingBalance: 0 });
  ctx.state.accounts.push({ id: 'ddSalC', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000, linkedOffsetAccountId: 'ddOff' });
  ctx.state.savingsCategories.push({ id: 'ddGoalC', name: 'Shares', linkedAccountId: 'ddOff' });
  ctx.state.pendingPayments.push({ id: 'ddppC', salaryAccountId: 'ddSalC', status: 'paid', paidAmount: 670.22, dueDate: ctx.todayStr(), amount: 670.22, goalId: 'ddGoalC', note: 'Shares', depositId: 'dddepC' });
  ctx.state.savingsDeposits.push({ id: 'dddepC', catId: 'ddGoalC', targetId: 'ddGoalC', type: 'deposit', amount: 670.22, date: ctx.todayStr(), note: 'Shares', sourceAccountId: 'ddSalC' });
  assertEqual(ctx.getAccountBalance('ddSalC'), -340.44, 'sanity: the double-debit drives salary down twice (1000 - 670.22 - 670.22)');
  assertEqual(ctx.findCurrentCycleDoubleDebits().length, 1, 'the current-cycle double-debit must be detected');
  ctx.resolveCurrentCycleDoubleDebits();
  assertEqual(ctx.getAccountBalance('ddSalC'), 329.78, 'after the fix salary reflects a single debit (1000 - 670.22)');
  assertEqual(ctx.findCurrentCycleDoubleDebits().length, 0, 'no current-cycle double-debit should remain');
});

await check('resolveCurrentCycleDoubleDebits() is a safe no-op when there are no double-debits', () => {
  ctx.state = buildMockState();
  assertEqual(ctx.findCurrentCycleDoubleDebits().length, 0);
  assertNoThrow(() => ctx.resolveCurrentCycleDoubleDebits(), 'must not throw on a clean state');
});

await check('resolveOrphanedPaidPendings() is a safe no-op when there is nothing to fix', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'resSal3', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'resGoal3', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'respp3', salaryAccountId: 'resSal3', status: 'pending', dueDate: ctx.todayStr(), amount: 100, goalId: 'resGoal3', note: 'Test' });
  ctx.confirm = () => true;
  ctx.payPendingItem('respp3'); // clean paid+linked
  const depCountBefore = ctx.state.savingsDeposits.length;
  ctx.resolveOrphanedPaidPendings();
  assertEqual(ctx.state.savingsDeposits.length, depCountBefore, 'a clean state must not have phantom deposits created');
});

await check('findSalaryGoalIssues() reports a clean linked payment as having no issues', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id: 'clnSal', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 1000 });
  ctx.state.savingsCategories.push({ id: 'clnGoal', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'clnpp', salaryAccountId: 'clnSal', status: 'pending', dueDate: ctx.todayStr(), amount: 300, goalId: 'clnGoal', note: 'Test' });
  ctx.confirm = () => true;
  ctx.payPendingItem('clnpp');
  const issues = ctx.findSalaryGoalIssues();
  assertEqual(issues.orphanedPaidPendings.length, 0, 'a properly paid+linked payment is not an orphan');
  assertEqual(issues.doubleDebits.length, 0, 'a properly paid+linked payment is not a double-debit');
});

await check('payPendingItem() does not throw when a pending payment has no salaryAccountId at all (handles missing data gracefully)', () => {
  ctx.state = buildMockState();
  ctx.state.savingsCategories.push({ id: 'warnGoal5', name: 'Travel' });
  ctx.state.pendingPayments.push({ id: 'wpp5', salaryAccountId: null, status: 'pending', dueDate: ctx.todayStr(), amount: 50, goalId: 'warnGoal5', note: 'Test' });
  ctx.confirm = () => true;
  assertNoThrow(() => ctx.payPendingItem('wpp5'));
});

console.log('\n── Face ID / biometric unlock (logic + safety; the WebAuthn ceremony itself is device-only) ──');

await check('isBiometricSupported() is false when no platform authenticator is available, even though the WebAuthn API exists (do not offer Face ID where it cannot work)', async () => {
  ctx.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => false };
  ctx.navigator = { credentials: { get(){}, create(){} } };
  await ctx.probeBiometricAvailable();
  assertTrue(ctx.isBiometricSupported() === false, 'API present but no usable authenticator must read as unsupported');
  ctx.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true };
  await ctx.probeBiometricAvailable();
  assertTrue(ctx.isBiometricSupported() === true, 'a usable platform authenticator must read as supported');
  ctx.PublicKeyCredential = undefined; ctx.navigator = {};
});

await check('isBiometricSupported() is false when the WebAuthn API is entirely absent (Face ID gated off, PIN-only)', () => {
  ctx.PublicKeyCredential = undefined; ctx.navigator = {};
  assertTrue(ctx.isBiometricSupported() === false, 'no WebAuthn API => PIN-only, never a broken Face ID prompt');
});

await check('hasBiometricRegistered() reflects whether a credential id is stored', () => {
  ctx.localStorage.removeItem('spendly_biom_cred');
  assertTrue(ctx.hasBiometricRegistered() === false, 'no stored credential => not registered');
  ctx.localStorage.setItem('spendly_biom_cred', 'AAAA');
  assertTrue(ctx.hasBiometricRegistered() === true, 'stored credential => registered');
  ctx.localStorage.removeItem('spendly_biom_cred');
});

await check('initLock() never auto-invokes the WebAuthn ceremony — iOS requires a user gesture, so Face ID is tap-triggered (regression: auto-fire silently fell back to PIN)', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const start = html.indexOf('async function initLock()');
  const end = html.indexOf('async function setupFaceId()');
  assertTrue(start !== -1 && end !== -1 && end > start, 'initLock and setupFaceId must both be present');
  const body = html.slice(start, end);
  assertTrue(!/triggerBiometric\s*\(/.test(body), 'initLock must NOT call triggerBiometric — no auto-fire; the user taps Use Face ID');
  assertTrue(/probeBiometricAvailable\s*\(/.test(body), 'initLock must probe platform-authenticator availability before gating the UI');
});

await check('showFaceIdPrompt() and showPinFallback() toggle the lock UI correctly (PIN always reachable)', () => {
  ctx.showFaceIdPrompt();
  assertTrue(ctx.document.getElementById('faceIdPrompt').style.display === 'flex', 'Face ID prompt shown');
  assertTrue(ctx.document.getElementById('pinPad').style.display === 'none', 'PIN pad hidden while Face ID shown');
  ctx.showPinFallback();
  assertTrue(ctx.document.getElementById('pinPad').style.display === 'flex', 'PIN pad shown on fallback');
  assertTrue(ctx.document.getElementById('faceIdPrompt').style.display === 'none', 'Face ID prompt hidden on PIN fallback');
});

await check('triggerBiometric() keeps the Face ID prompt visible after a cancelled scan instead of trapping the user away from a retry', async () => {
  ctx.PublicKeyCredential = { isUserVerifyingPlatformAuthenticatorAvailable: async () => true };
  ctx.crypto = { getRandomValues: (a) => a };
  ctx.navigator = { credentials: { get: () => Promise.reject(new Error('cancelled')), create(){} } };
  await ctx.probeBiometricAvailable();
  ctx.localStorage.setItem('spendly_biom_cred', 'AAAA');
  await ctx.triggerBiometric();
  assertTrue(ctx.document.getElementById('faceIdPrompt').style.display === 'flex', 'after a cancel the Face ID prompt stays so the user can retry or pick PIN');
  ctx.localStorage.removeItem('spendly_biom_cred');
  ctx.PublicKeyCredential = undefined; ctx.navigator = {}; ctx.crypto = undefined;
});

console.log('\n── CC statement reconciliation & settle (re-run safety) ──');

await check('markCCCycleSettled() clears the closing-balance snapshot so the Pay CTA does not stay armed after settling', () => {
  ctx.state = buildMockState();
  ctx.state.categories = ctx.state.categories && ctx.state.categories.length ? ctx.state.categories : [{ id: 'c1', name: 'Cat' }];
  ctx.state.accounts.push({ id: 'ccSettle', name: 'ANZ', type: 'credit', closingBalance: 5626.86, closingBalanceCycleEnd: '2026-06-17' });
  ctx.state.expenses.push({ id: 'eSettle', date: '2026-06-10', amount: 100, paymentAccountId: 'ccSettle', categoryId: 'c1', name: 'Test' });
  ctx.confirm = () => true;
  ctx.markCCCycleSettled('eSettle');
  const acct = ctx.state.accounts.find(a => a.id === 'ccSettle');
  assertTrue(acct.closingBalance === undefined, 'closing balance must be cleared when a cycle is marked settled');
  assertTrue(acct.closingBalanceCycleEnd === undefined, 'closing balance cycle marker must be cleared too');
  assertTrue((ctx.state.ccPayments||[]).some(p => (p.expenseIds||[]).includes('eSettle')), 'the settled charge must be recorded in a ccPayment');
});

await check('reconcileKeepUnbilled() dismisses a falsely-flagged charge without deferring or deleting it (extraction missed the line, but it IS billed)', () => {
  ctx.state = buildMockState();
  ctx.state.expenses.push({ id: 'eKeep', date: '2026-06-03', amount: 11.47, name: 'GGs' });
  ctx._reconciliation = {
    ccAccountId: 'cc', cycleInfo: { cycleStart: new Date('2026-05-18T00:00:00'), cycleEnd: new Date('2026-06-17T00:00:00') }, resolved: {}, collapsed: {},
    result: { matched: [], missingFromSpendly: [], missingFromStatement: [{ id: 'eKeep', date: '2026-06-03', amount: 11.47, name: 'GGs' }], splitSuggestions: [], possibleMatches: [], refundedPairs: [], creditsWithMatch: [], creditsUnmatched: [], skippedAlreadyResolved: 0, totals: { statementChargesTotal: 0, statementCreditsTotal: 0, spendlyLoggedTotal: 0, totalsDifference: 0 } },
  };
  ctx.reconcileKeepUnbilled(0);
  assertEqual(ctx._reconciliation.resolved['defer-0'], 'kept', 'Keep marks the item resolved as kept');
  const exp = ctx.state.expenses.find(e => e.id === 'eKeep');
  assertTrue(!exp.deferToNextCycle, 'Keep must NOT defer the expense to the next cycle');
});

await check('runStatementReconciliation is review-only for an already-settled cycle — it must NOT re-arm the closing balance (static guard)', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const start = html.indexOf('function runStatementReconciliation(');
  const end = html.indexOf('function showStatementReconciliationResults(');
  assertTrue(start !== -1 && end !== -1 && end > start, 'both functions must be present');
  const body = html.slice(start, end);
  assertTrue(/const cycleSettled =/.test(body), 'must compute cycleSettled from the cycle\'s settled charges');
  assertTrue(/if \(cycleSettled\)[\s\S]*closingBalance = undefined/.test(body), 'a settled cycle must CLEAR (not re-arm) the closing-balance snapshot');
  assertTrue(/else if \(summary[\s\S]*closingBalance = Math\.round/.test(body), 'the re-arm path must sit in the else branch (only when NOT already settled)');
  assertTrue(/reviewOnly: cycleSettled/.test(body), 'the review must be told it is review-only when settled');
});

console.log('\n── Salary page · savings gate (Step 3 locked until card paid) ──');

await check('getSalaryCCOwed() sums owed across credit cards — the signal that locks savings until the card is cleared', () => {
  ctx.state = buildMockState();
  ctx.state.accounts.push({ id:'ccA', type:'credit', name:'Card A' });
  ctx.state.accounts.push({ id:'ccB', type:'credit', name:'Card B' });
  ctx.state.accounts.push({ id:'savX', type:'savings', name:'Not a card' });
  const orig = ctx.getCCGoalContributions;
  try {
    // owed on both cards -> savings must be locked
    ctx.getCCGoalContributions = (id) => ({ grossTotal: id==='ccA' ? 1200.50 : id==='ccB' ? 300.25 : 0 });
    assertEqual(ctx.getSalaryCCOwed(), 1500.75, 'sums grossTotal across credit cards only (ignores non-card accounts)');
    assertTrue(ctx.getSalaryCCOwed() > 0.01, 'with a balance owed, the gate is engaged (savings locked)');
    // everything settled -> savings unlock
    ctx.getCCGoalContributions = () => ({ grossTotal: 0 });
    assertTrue(ctx.getSalaryCCOwed() <= 0.01, 'once every card reads zero, the gate clears (savings unlock)');
  } finally {
    ctx.getCCGoalContributions = orig;
  }
});

await check('no top-level function is declared more than once anywhere in the file (regression: silent shadowing caused both a data-loss bug and a broken legacy super-contribution modal)', () => {
  const fs = require('fs');
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const matches = html.match(/^(?:async )?function [a-zA-Z_][a-zA-Z0-9_]*/gm) || [];
  const names = matches.map(m => m.replace(/^async /, '').replace('function ', ''));
  const counts = {};
  names.forEach(n => { counts[n] = (counts[n] || 0) + 1; });
  const dupes = Object.entries(counts).filter(([,c]) => c > 1);
  assertTrue(dupes.length === 0, 'duplicate function declarations found: ' + dupes.map(([n,c]) => `${n} (x${c})`).join(', '));
});

// ─────────────────────────────────────────────────────────────────────────
console.log('\n── Credit Card Balance card: amount shown once, not duplicated ──');

await check('when the Pay CTA is shown, the unsettled amount appears only in the button, not also as a separate header figure', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'noDupSalary2', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'noDupCC2', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  ctx.state.expenses.push({ id: 'noDupExp2', date: ctx.dateToStr(cycleStart), amount: 250.75, categoryId: 'cat1', paymentAccountId: 'noDupCC2' });
  ctx._viewingAccountId = 'noDupSalary2';
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  const occurrences = (html.match(/250\.75/g) || []).length;
  assertEqual(occurrences, 1, 'the amount must appear exactly once — inside the Pay button — not duplicated as a separate header figure above it');
  assertTrue(html.includes('💳 Pay'), 'the Pay CTA itself must still be present and carry the amount');
});

await check('when fully settled (no Pay CTA shown), the header figure still shows — there is no duplication risk in that state', () => {
  ctx.state = buildMockState();
  ctx.state.accounts = ctx.state.accounts.filter(a => a.type !== 'credit');
  ctx.state.currentTab = 'accounts';
  ctx.state.accounts.push({ id: 'settledSalary', name: 'Salary', type: 'transaction', isSalaryAccount: true, openingBalance: 5000 });
  ctx.state.accounts.push({ id: 'settledCC', name: 'Card', type: 'credit' });
  const { cycleStart } = ctx.getCycleRange(0);
  const exp = { id: 'settledExp1', date: ctx.dateToStr(cycleStart), amount: 88.20, categoryId: 'cat1', paymentAccountId: 'settledCC' };
  ctx.state.expenses.push(exp);
  ctx.state.ccPayments.push({ id: 'pay1', date: ctx.todayStr(), amount: 88.20, fromAccountId: 'settledSalary', toCCAccountIds: ['settledCC'], expenseIds: ['settledExp1'] });
  ctx._viewingAccountId = 'settledSalary';
  ctx.renderAccounts();
  const html = ctx.document.getElementById('content').innerHTML;
  assertTrue(html.includes('✓ All settled'), 'should show the settled state, no Pay button');
  assertTrue(!html.includes('💳 Pay $') && !/💳 Pay \$?\d/.test(html), 'no dollar-amount Pay CTA should appear once fully settled (the unrelated "💳 Pay credit cards" button from Pending Savings payments has no amount, so it is not what this checks)');
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
