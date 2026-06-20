// ── Mock state fixture ──────────────────────────────────────────────────────
function buildMockState() {
  return {
    currentTab: 'dashboard',
    viewingCycleOffset: 0,
    budget: 8230.81,
    cycleDay: 18,
    cycleType: 'monthly',
    appName: 'Spendly',
    categories: [
      { id: 'cat1', name: 'Groceries', icon: '🛒' },
      { id: 'cat2', name: 'Mortgage', icon: '🏠' },
    ],
    expenses: [],
    recurringExpenses: [],
    recurringSavings: [],
    recurringIncome: [],
    recurringSkips: [],
    savingsCategories: [
      { id: 'goal1', name: 'Home savings', icon: '🏠', status: 'active', linkedAccountId: 'offset1' },
    ],
    savingsSubcategories: [],
    savingsDeposits: [],
    recyclingTrips: [],
    mortgage: {},
    taxCategories: [],
    taxTransactions: [],
    giftCards: [],
    portfolio: [],
    netWorth: [],
    notes: [],
    accounts: [
      { id: 'salary1', name: 'Salary', type: 'transaction', isSalaryAccount: true, linkedOffsetAccountId: 'offset1', openingBalance: 0 },
      { id: 'offset1', name: 'Offset Account', type: 'offset', openingBalance: 0 },
      { id: 'cc1', name: 'ANZ CC', type: 'credit', openingBalance: 0 },
    ],
    accountTransactions: [],
    pendingPayments: [],
    ccPayments: [],
    lastActiveDate: '',
    setupDone: true,
  };
}

// Helper: builds a date string N days from a base ISO date (YYYY-MM-DD)
function addDays(baseStr, n) {
  const d = new Date(baseStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = { buildMockState, addDays };
