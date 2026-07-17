import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';

export const wellnessRouter = Router();

/**
 * GET /api/wellness/sessions
 * Returns all wellness sessions. Supports ?type= (live/self-paced) and ?category= filters.
 */
wellnessRouter.get('/sessions', async (req, res) => {
  try {
    const { type, category } = req.query;

    let query = supabaseAdmin
      .from('wellness_sessions')
      .select('*')
      .eq('is_active', true);

    if (type) query = query.eq('type', type);
    if (category) query = query.eq('category', category);

    const { data, error } = await query.order('scheduled_at', { ascending: true, nullsFirst: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch sessions' });
      return;
    }

    res.json({ sessions: data || [] });
  } catch (err) {
    console.error('Get sessions error:', err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});
