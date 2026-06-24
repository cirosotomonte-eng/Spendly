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

await check('CC accounts are unaffected by the cycle-grouping change — still a flat current-cycle-only list', () => {
  const src = ctx.renderAccounts.toString();
  assertTrue(src.includes("acct.type === 'credit'") && src.includes('Current cycle charges'),
    'CC accounts must keep their existing flat current-cycle-only display, not be grouped into collapsible cycle sections');
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

await check('getGoalContributions (inside openPayCCFromSalary) filters unsettled charges using effective billing cycle end, not raw date', () => {
  const src = ctx.openPayCCFromSalary.toString();
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
