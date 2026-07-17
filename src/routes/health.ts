import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const healthRouter = Router();

/**
 * GET /api/health-records
 * Returns the current user's health records.
 */
healthRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { type } = req.query;

    let query = supabaseAdmin
      .from('health_records')
      .select('*')
      .eq('user_id', req.userId);

    if (type) query = query.eq('record_type', type);

    const { data, error } = await query.order('record_date', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch records' });
      return;
    }

    res.json({ records: data || [] });
  } catch (err) {
    console.error('Get records error:', err);
    res.status(500).json({ error: 'Failed to fetch records' });
  }
});

/**
 * POST /api/health-records
 * Create a new health record. File should already be uploaded to Supabase Storage;
 * this endpoint just logs the metadata.
 */
healthRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { record_type, record_date, file_url, file_name, notes } = req.body;

    if (!record_type) {
      res.status(400).json({ error: 'record_type is required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('health_records')
      .insert({
        user_id: req.userId,
        record_type,
        record_date: record_date || new Date().toISOString().split('T')[0],
        file_url: file_url || null,
        file_name: file_name || null,
        notes: notes || null,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to create record' });
      return;
    }

    res.status(201).json({ record: data });
  } catch (err) {
    console.error('Create record error:', err);
    res.status(500).json({ error: 'Failed to create record' });
  }
});

/**
 * POST /api/health-records/upload-url
 * Generates a signed upload URL for Supabase Storage.
 */
healthRouter.post('/upload-url', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { file_name, content_type } = req.body;

    if (!file_name) {
      res.status(400).json({ error: 'file_name is required' });
      return;
    }

    const path = `${req.userId}/${Date.now()}-${file_name}`;

    const { data, error } = await supabaseAdmin.storage
      .from('health-records')
      .createSignedUploadUrl(path);

    if (error) {
      res.status(500).json({ error: 'Failed to generate upload URL' });
      return;
    }

    res.json({
      upload_url: data.signedUrl,
      file_path: path,
      public_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/health-records/${path}`,
    });
  } catch (err) {
    console.error('Upload URL error:', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

/**
 * GET /api/health-records/symptoms
 * Returns the user's symptom logs.
 */
healthRouter.get('/symptoms', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('symptom_logs')
      .select('*')
      .eq('user_id', req.userId)
      .order('logged_at', { ascending: false })
      .limit(50);

    if (error) {
      res.status(500).json({ error: 'Failed to fetch symptoms' });
      return;
    }

    res.json({ symptoms: data || [] });
  } catch (err) {
    console.error('Get symptoms error:', err);
    res.status(500).json({ error: 'Failed to fetch symptoms' });
  }
});

/**
 * POST /api/health-records/symptoms
 * Log a symptom.
 */
healthRouter.post('/symptoms', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { symptom, severity, notes } = req.body;

    const { data, error } = await supabaseAdmin
      .from('symptom_logs')
      .insert({
        user_id: req.userId,
        symptom,
        severity: severity || 'mild',
        notes: notes || null,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to log symptom' });
      return;
    }

    res.status(201).json({ symptom: data });
  } catch (err) {
    console.error('Log symptom error:', err);
    res.status(500).json({ error: 'Failed to log symptom' });
  }
});
