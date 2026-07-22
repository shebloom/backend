import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

import { LOCAL_WELLNESS_PROGRAMS } from '../lib/memoryStore';

export const programsRouter = Router();

/**
 * GET /api/programs
 * Returns all wellness programs. Supports ?category= filter.
 */
programsRouter.get('/', async (req, res) => {
  try {
    const { category } = req.query;

    let query = supabaseAdmin
      .from('wellness_programs')
      .select('*')
      .eq('is_active', true);

    if (category && category !== 'All') {
      query = query.eq('category', category);
    }

    const { data } = await query.order('created_at', { ascending: false });
    const dbPrograms = data || [];
    
    // Combine db and memory programs
    const combined = [...LOCAL_WELLNESS_PROGRAMS, ...dbPrograms];
    const unique = Array.from(new Map(combined.map(p => [p.id, p])).values());

    // Apply category filtering to combined list
    const filtered = category && category !== 'All'
      ? unique.filter(p => p.category?.toLowerCase() === (category as string).toLowerCase())
      : unique;

    res.json({ programs: filtered });
  } catch (err) {
    console.error('Get programs error:', err);
    res.json({ programs: LOCAL_WELLNESS_PROGRAMS });
  }
});

/**
 * GET /api/programs/:id
 */
programsRouter.get('/:id', async (req, res) => {
  try {
    const memProg = LOCAL_WELLNESS_PROGRAMS.find(p => p.id === req.params.id);
    if (memProg) {
      res.json({ program: memProg });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('wellness_programs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Program not found' });
      return;
    }

    res.json({ program: data });
  } catch (err) {
    console.error('Get program error:', err);
    res.status(500).json({ error: 'Failed to fetch program' });
  }
});

/**
 * POST /api/programs/:id/enroll
 * Enroll current user in a program.
 */
programsRouter.post('/:id/enroll', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    // Check if already enrolled
    const { data: existing } = await supabaseAdmin
      .from('program_enrollments')
      .select('id')
      .eq('user_id', req.userId)
      .eq('program_id', req.params.id)
      .single();

    if (existing) {
      res.status(409).json({ error: 'Already enrolled in this program' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('program_enrollments')
      .insert({
        user_id: req.userId,
        program_id: req.params.id,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to enroll' });
      return;
    }

    res.status(201).json({ enrollment: data });
  } catch (err) {
    console.error('Enrollment error:', err);
    res.status(500).json({ error: 'Failed to enroll' });
  }
});

/**
 * GET /api/programs/enrollments/mine
 * Returns all programs the current user is enrolled in.
 */
programsRouter.get('/enrollments/mine', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('program_enrollments')
      .select('*, wellness_programs(*)')
      .eq('user_id', req.userId);

    if (error) {
      res.status(500).json({ error: 'Failed to fetch enrollments' });
      return;
    }

    res.json({ enrollments: data || [] });
  } catch (err) {
    console.error('Get enrollments error:', err);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});
