import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const cycleRouter = Router();

/**
 * GET /api/cycle/logs
 * Returns cycle logs for the current user. Supports ?month=YYYY-MM filter.
 */
cycleRouter.get('/logs', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { month } = req.query;

    let query = supabaseAdmin
      .from('cycle_logs')
      .select('*')
      .eq('user_id', req.userId)
      .order('log_date', { ascending: true });

    if (month && typeof month === 'string') {
      const [year, m] = month.split('-');
      const startDate = `${year}-${m}-01`;
      const endDate = new Date(Number(year), Number(m), 0).toISOString().split('T')[0];
      query = query.gte('log_date', startDate).lte('log_date', endDate);
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: 'Failed to fetch cycle logs' });
      return;
    }

    res.json({ logs: data || [] });
  } catch (err) {
    console.error('Get cycle logs error:', err);
    res.status(500).json({ error: 'Failed to fetch cycle logs' });
  }
});

/**
 * POST /api/cycle/logs
 * Log cycle data for a specific date.
 */
cycleRouter.post('/logs', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { log_date, state, notes } = req.body;

    if (!log_date || !state) {
      res.status(400).json({ error: 'log_date and state are required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('cycle_logs')
      .upsert(
        {
          user_id: req.userId,
          log_date,
          state,
          notes: notes || null,
        },
        { onConflict: 'user_id,log_date' }
      )
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to save cycle log' });
      return;
    }

    res.json({ log: data });
  } catch (err) {
    console.error('Save cycle log error:', err);
    res.status(500).json({ error: 'Failed to save cycle log' });
  }
});

/**
 * PUT /api/cycle/period
 * Bulk update period dates (used by "Edit Period Dates" feature).
 * Expects { start_date, end_date } — marks all days in range as 'period'.
 * Also auto-computes ovulation & fertile window days for the current cycle.
 */
cycleRouter.put('/period', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { start_date, end_date } = req.body;

    if (!start_date || !end_date) {
      res.status(400).json({ error: 'start_date and end_date are required' });
      return;
    }

    // Generate period days
    const logs: Array<{ user_id: string; log_date: string; state: string }> = [];
    const current = new Date(start_date);
    const end = new Date(end_date);

    while (current <= end) {
      logs.push({
        user_id: req.userId!,
        log_date: current.toISOString().split('T')[0],
        state: 'period',
      });
      current.setDate(current.getDate() + 1);
    }

    // Fetch user's historical cycle length for ovulation prediction
    const { data: periodLogs } = await supabaseAdmin
      .from('cycle_logs')
      .select('log_date')
      .eq('user_id', req.userId)
      .eq('state', 'period')
      .order('log_date', { ascending: true });

    // Compute average cycle length from past data
    let cycleLength = 28; // default
    if (periodLogs && periodLogs.length > 0) {
      // Group consecutive period days into periods to find period starts
      const periodStarts: Date[] = [new Date(periodLogs[0].log_date)];
      for (let i = 1; i < periodLogs.length; i++) {
        const prev = new Date(periodLogs[i - 1].log_date);
        const curr = new Date(periodLogs[i].log_date);
        const diffDays = (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays > 1) {
          periodStarts.push(curr);
        }
      }
      if (periodStarts.length >= 2) {
        const cycleLengths: number[] = [];
        for (let i = 1; i < periodStarts.length; i++) {
          cycleLengths.push(
            Math.round((periodStarts[i].getTime() - periodStarts[i - 1].getTime()) / (1000 * 60 * 60 * 24))
          );
        }
        cycleLength = Math.round(cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length);
      }
    }

    // Compute ovulation day (typically 14 days before next period)
    const ovulationDayOffset = cycleLength - 14;
    const periodStartDate = new Date(start_date);

    // Ovulation day
    const ovulationDate = new Date(periodStartDate);
    ovulationDate.setDate(ovulationDate.getDate() + ovulationDayOffset);
    logs.push({
      user_id: req.userId!,
      log_date: ovulationDate.toISOString().split('T')[0],
      state: 'ovulation',
    });

    // Fertile window: 5 days before ovulation + 1 day after
    for (let offset = -5; offset <= 1; offset++) {
      if (offset === 0) continue; // skip ovulation day itself, already added
      const fertileDate = new Date(ovulationDate);
      fertileDate.setDate(fertileDate.getDate() + offset);
      // Don't overlap with period days
      const fertileDateStr = fertileDate.toISOString().split('T')[0];
      const isInPeriod = logs.some(l => l.log_date === fertileDateStr && l.state === 'period');
      if (!isInPeriod) {
        logs.push({
          user_id: req.userId!,
          log_date: fertileDateStr,
          state: 'fertile',
        });
      }
    }

    const { error } = await supabaseAdmin
      .from('cycle_logs')
      .upsert(logs, { onConflict: 'user_id,log_date' });

    if (error) {
      res.status(500).json({ error: 'Failed to update period dates' });
      return;
    }

    res.json({ success: true, days_updated: logs.length });
  } catch (err) {
    console.error('Update period error:', err);
    res.status(500).json({ error: 'Failed to update period dates' });
  }
});

/**
 * GET /api/cycle/insights
 * Computes average cycle length and average period length from logged history.
 */
cycleRouter.get('/insights', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data: logs, error } = await supabaseAdmin
      .from('cycle_logs')
      .select('log_date, state')
      .eq('user_id', req.userId)
      .eq('state', 'period')
      .order('log_date', { ascending: true });

    if (error || !logs || logs.length === 0) {
      res.json({
        avg_cycle_length: null,
        avg_period_length: null,
        total_cycles: 0,
      });
      return;
    }

    // Group consecutive period days into periods
    const periods: Array<{ start: string; end: string; length: number }> = [];
    let periodStart = logs[0].log_date;
    let periodEnd = logs[0].log_date;

    for (let i = 1; i < logs.length; i++) {
      const prevDate = new Date(logs[i - 1].log_date);
      const currDate = new Date(logs[i].log_date);
      const diffDays = (currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);

      if (diffDays <= 1) {
        periodEnd = logs[i].log_date;
      } else {
        const length = Math.round(
          (new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / (1000 * 60 * 60 * 24)
        ) + 1;
        periods.push({ start: periodStart, end: periodEnd, length });
        periodStart = logs[i].log_date;
        periodEnd = logs[i].log_date;
      }
    }
    // Push the last period
    const lastLength = Math.round(
      (new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / (1000 * 60 * 60 * 24)
    ) + 1;
    periods.push({ start: periodStart, end: periodEnd, length: lastLength });

    // Compute cycle lengths (days between period starts)
    const cycleLengths: number[] = [];
    for (let i = 1; i < periods.length; i++) {
      const diff = Math.round(
        (new Date(periods[i].start).getTime() - new Date(periods[i - 1].start).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      cycleLengths.push(diff);
    }

    const avgCycleLength = cycleLengths.length > 0
      ? Math.round(cycleLengths.reduce((a, b) => a + b, 0) / cycleLengths.length)
      : null;

    const avgPeriodLength = periods.length > 0
      ? Math.round(periods.reduce((a, b) => a + b.length, 0) / periods.length)
      : null;

    res.json({
      avg_cycle_length: avgCycleLength,
      avg_period_length: avgPeriodLength,
      total_cycles: periods.length,
      last_period_start: periods[periods.length - 1]?.start || null,
    });
  } catch (err) {
    console.error('Cycle insights error:', err);
    res.status(500).json({ error: 'Failed to compute insights' });
  }
});
