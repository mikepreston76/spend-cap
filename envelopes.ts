// lib/envelopes.ts
//
// Calculation + query layer for the envelope budgeting extension.
// Assumes an existing `lib/supabaseClient.ts` exporting a configured
// supabase-js client as `supabase`. Adjust the import path to match
// your actual repo layout.

import { supabase } from './supabaseClient';

export interface Category {
  id: string;
  name: string;
  monthly_cap: number;
  rollover: boolean;
  active: boolean;
  created_at: string;
}

export interface CategoryStatus {
  category: Category;
  monthStart: string;       // YYYY-MM-01
  spentThisMonth: number;
  netTransfersThisMonth: number; // + = moved in, - = moved out
  rolloverCarry: number;    // 0 if category.rollover is false
  effectiveCap: number;     // monthly_cap + netTransfersThisMonth + rolloverCarry
  remaining: number;        // effectiveCap - spentThisMonth
  overspent: boolean;
  daysLeftInMonth: number;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthStartISO(d: Date): string {
  return `${monthKey(d)}-01`;
}

function daysLeftInMonth(d: Date): number {
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return lastDay - d.getDate() + 1; // inclusive of today
}

/**
 * Fetches all active categories.
 */
export async function listActiveCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data as Category[];
}

/**
 * Computes the full status (spent, remaining, rollover carry) for one
 * category as of `asOf` (defaults to today).
 *
 * Rollover model: if category.rollover is true, any month's leftover
 * (remaining, which can be negative if overspent) carries into the next
 * month indefinitely — mirroring how the Daily Allowance's Running
 * Balance already works. If rollover is false, each month resets to
 * monthly_cap + that month's net transfers, full stop.
 *
 * Transfers are NOT rolled forward independently — a transfer changes
 * the effective cap for the month it's dated in, and if the category
 * rolls over, that month's transfer effect flows into rolloverCarry
 * like everything else. This keeps transfers and monthly cap symmetric:
 * both are just inputs to "remaining," and "remaining" is the only
 * thing that ever carries.
 */
export async function getCategoryStatus(
  categoryId: string,
  asOf: Date = new Date()
): Promise<CategoryStatus> {
  const { data: categoryRow, error: catErr } = await supabase
    .from('categories')
    .select('*')
    .eq('id', categoryId)
    .single();
  if (catErr) throw catErr;
  const category = categoryRow as Category;

  const createdAt = new Date(category.created_at);
  const startMonth = new Date(createdAt.getFullYear(), createdAt.getMonth(), 1);
  const asOfMonth = new Date(asOf.getFullYear(), asOf.getMonth(), 1);

  // Pull full history once; cheap for a personal-scale app.
  const [{ data: logs, error: logErr }, { data: transfersIn, error: tInErr }, { data: transfersOut, error: tOutErr }] =
    await Promise.all([
      supabase.from('category_logs').select('amount, date').eq('category_id', categoryId),
      supabase.from('transfers').select('amount, date').eq('to_category_id', categoryId),
      supabase.from('transfers').select('amount, date').eq('from_category_id', categoryId),
    ]);
  if (logErr) throw logErr;
  if (tInErr) throw tInErr;
  if (tOutErr) throw tOutErr;

  const spentByMonth = new Map<string, number>();
  for (const row of logs ?? []) {
    const k = monthKey(new Date(row.date));
    spentByMonth.set(k, (spentByMonth.get(k) ?? 0) + Number(row.amount));
  }

  const netTransferByMonth = new Map<string, number>();
  for (const row of transfersIn ?? []) {
    const k = monthKey(new Date(row.date));
    netTransferByMonth.set(k, (netTransferByMonth.get(k) ?? 0) + Number(row.amount));
  }
  for (const row of transfersOut ?? []) {
    const k = monthKey(new Date(row.date));
    netTransferByMonth.set(k, (netTransferByMonth.get(k) ?? 0) - Number(row.amount));
  }

  // Walk month by month from category creation up to (but not including)
  // asOfMonth, accumulating rollover if enabled, to get the carry-in for
  // the current month. O(months since creation) — trivial at personal-app
  // scale, avoids needing a SQL window function.
  let incomingCarry = 0;
  if (category.rollover) {
    let cursor = new Date(startMonth);
    while (cursor < asOfMonth) {
      const k = monthKey(cursor);
      const spent = spentByMonth.get(k) ?? 0;
      const netTransfer = netTransferByMonth.get(k) ?? 0;
      const effectiveCapForMonth = category.monthly_cap + netTransfer + incomingCarry;
      incomingCarry = effectiveCapForMonth - spent;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
  }

  const currentMonthKey = monthKey(asOfMonth);
  const spentThisMonth = spentByMonth.get(currentMonthKey) ?? 0;
  const netTransfersThisMonth = netTransferByMonth.get(currentMonthKey) ?? 0;
  const effectiveCap = category.monthly_cap + netTransfersThisMonth + (category.rollover ? incomingCarry : 0);
  const remaining = effectiveCap - spentThisMonth;

  return {
    category,
    monthStart: monthStartISO(asOf),
    spentThisMonth,
    netTransfersThisMonth,
    rolloverCarry: category.rollover ? incomingCarry : 0,
    effectiveCap,
    remaining,
    overspent: remaining < 0,
    daysLeftInMonth: daysLeftInMonth(asOf),
  };
}

/**
 * Convenience: status for every active category at once.
 */
export async function getAllCategoryStatuses(asOf: Date = new Date()): Promise<CategoryStatus[]> {
  const categories = await listActiveCategories();
  return Promise.all(categories.map((c) => getCategoryStatus(c.id, asOf)));
}

/**
 * Net effect of transfers on the Daily Allowance side for a given month.
 * Positive = money moved INTO Daily Allowance from envelopes this month.
 * Negative = money moved OUT of Daily Allowance into envelopes this month.
 *
 * IMPORTANT INTEGRATION POINT: this number needs to be added into your
 * existing Daily Allowance "Running Balance" calculation. That logic
 * isn't included here since it lives in your existing codebase — find
 * where Running Balance is computed (likely `cap - spend` summed per
 * day) and add this month's net transfer delta into that sum. See the
 * README for details.
 */
export async function getDailyAllowanceTransferNet(asOf: Date = new Date()): Promise<number> {
  const monthStart = monthStartISO(asOf);
  const nextMonth = new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1);
  const monthEnd = monthStartISO(nextMonth);

  const [{ data: into, error: e1 }, { data: outOf, error: e2 }] = await Promise.all([
    supabase.from('transfers').select('amount').is('to_category_id', null).gte('date', monthStart).lt('date', monthEnd),
    supabase.from('transfers').select('amount').is('from_category_id', null).gte('date', monthStart).lt('date', monthEnd),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;

  const inSum = (into ?? []).reduce((s, r) => s + Number(r.amount), 0);
  const outSum = (outOf ?? []).reduce((s, r) => s + Number(r.amount), 0);
  return inSum - outSum;
}

/**
 * Logs a spend against a category.
 */
export async function logCategorySpend(categoryId: string, amount: number, date: string, note?: string) {
  const { error } = await supabase
    .from('category_logs')
    .insert({ category_id: categoryId, amount, date, note: note ?? null });
  if (error) throw error;
}

/**
 * Records a transfer. Pass null for fromCategoryId/toCategoryId to
 * represent the Daily Allowance side.
 */
export async function createTransfer(
  fromCategoryId: string | null,
  toCategoryId: string | null,
  amount: number,
  date: string,
  note?: string
) {
  if (!fromCategoryId && !toCategoryId) {
    throw new Error('Transfer must have at least one non-null side.');
  }
  if (fromCategoryId && toCategoryId && fromCategoryId === toCategoryId) {
    throw new Error('Cannot transfer a category to itself.');
  }
  const { error } = await supabase.from('transfers').insert({
    from_category_id: fromCategoryId,
    to_category_id: toCategoryId,
    amount,
    date,
    note: note ?? null,
  });
  if (error) throw error;
}

/**
 * Creates a new category envelope.
 */
export async function createCategory(name: string, monthlyCap: number, rollover: boolean) {
  const { error } = await supabase.from('categories').insert({
    name,
    monthly_cap: monthlyCap,
    rollover,
    active: true,
  });
  if (error) throw error;
}

/**
 * Archives (soft-deletes) a category. History in category_logs and
 * transfers is preserved.
 */
export async function archiveCategory(categoryId: string) {
  const { error } = await supabase.from('categories').update({ active: false }).eq('id', categoryId);
  if (error) throw error;
}

export async function updateCategory(
  categoryId: string,
  updates: Partial<Pick<Category, 'name' | 'monthly_cap' | 'rollover' | 'active'>>
) {
  const { error } = await supabase.from('categories').update(updates).eq('id', categoryId);
  if (error) throw error;
}
