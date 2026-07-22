import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth';
import { LOCAL_WELLNESS_SESSIONS } from '../lib/memoryStore';

export const wellnessRouter = Router();

// Empty initial state so only programs created by Admin are shown
const DEFAULT_CONDITIONS: any[] = [];
const DEFAULT_VIDEOS: any[] = [];

// Memory persistent fallback stores
const CUSTOM_CONDITIONS: any[] = [];
const CUSTOM_VIDEOS: any[] = [];

async function getYogaConditions() {
  const { data, error } = await supabaseAdmin
    .from('yoga_conditions')
    .select('*')
    .order('order_index', { ascending: true });

  const dbList = (error || !data || data.length === 0) ? DEFAULT_CONDITIONS : data;
  const combined = [...dbList, ...CUSTOM_CONDITIONS];
  return Array.from(new Map(combined.map(c => [c.id, c])).values());
}

async function getYogaVideos(conditionId?: string) {
  let query = supabaseAdmin.from('yoga_videos').select('*').order('order_index', { ascending: true });
  if (conditionId) {
    query = query.eq('condition_id', conditionId);
  }

  const { data, error } = await query;
  let list = (error || !data || data.length === 0) ? DEFAULT_VIDEOS : data;
  const combined = [...list, ...CUSTOM_VIDEOS];
  const unique = Array.from(new Map(combined.map(v => [v.id, v])).values());

  if (conditionId) {
    return unique.filter(v => v.condition_id === conditionId);
  }
  return unique;
}

/**
 * GET /api/wellness/conditions
 * Returns all Yoga Condition categories.
 */
wellnessRouter.get('/conditions', async (_req, res) => {
  try {
    const conditions = await getYogaConditions();
    const allVideos = await getYogaVideos();

    const results = conditions.map(c => {
      const conditionVideos = allVideos.filter(v => v.condition_id === c.id);
      return {
        ...c,
        video_count: conditionVideos.length,
        videos: conditionVideos,
      };
    });

    res.json({ conditions: results });
  } catch (err) {
    console.error('Get yoga conditions error:', err);
    res.status(500).json({ error: 'Failed to fetch yoga condition categories' });
  }
});

/**
 * GET /api/wellness/conditions/:id
 * Returns a single condition and its course playlist of video classes.
 */
wellnessRouter.get('/conditions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const conditions = await getYogaConditions();
    const condition = conditions.find(c => c.id === id || c.category_slug === id);

    if (!condition) {
      res.status(404).json({ error: 'Condition category not found' });
      return;
    }

    const videos = await getYogaVideos(condition.id);

    res.json({
      condition: {
        ...condition,
        videos,
      },
    });
  } catch (err) {
    console.error('Get condition error:', err);
    res.status(500).json({ error: 'Failed to fetch condition details' });
  }
});

/**
 * ADMIN: POST /api/wellness/categories
 * Create new condition category (Admin customizable).
 */
wellnessRouter.post('/admin/categories', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const { title, description, thumbnail_url, category_slug } = req.body;

    if (!title || !title.trim()) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const newCategory = {
      id: `cat-${Date.now()}`,
      title: title.trim(),
      category_slug: category_slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      description: description?.trim() || 'Custom wellness program category',
      thumbnail_url: thumbnail_url || 'https://images.unsplash.com/photo-1545205597-3d9d02c29597?auto=format&fit=crop&w=600&q=80',
      order_index: Date.now(),
    };

    CUSTOM_CONDITIONS.unshift(newCategory);

    const { data } = await supabaseAdmin
      .from('yoga_conditions')
      .insert(newCategory)
      .select()
      .single();

    res.status(201).json({ category: data || newCategory });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ error: 'Failed to create condition category' });
  }
});

/**
 * ADMIN: POST /api/wellness/videos
 * Add a video class to a category with automatic "Class 1, Class 2..." numbering.
 */
wellnessRouter.post('/admin/videos', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const { condition_id, title, description, duration, video_url, thumbnail_url } = req.body;

    if (!condition_id || !title || !video_url) {
      res.status(400).json({ error: 'condition_id, title, and video_url are required' });
      return;
    }

    // Auto-numbering: count existing videos in this category to format "Class 1: Title", "Class 2: Title"
    const existingVideos = await getYogaVideos(condition_id);
    const classNum = existingVideos.length + 1;
    const rawTitle = title.trim();
    const formattedTitle = /^class\s+\d+/i.test(rawTitle)
      ? rawTitle
      : `Class ${classNum}: ${rawTitle}`;

    const newVideo = {
      id: `v-${Date.now()}`,
      condition_id,
      title: formattedTitle,
      description: description?.trim() || '',
      duration: duration?.trim() || '20 min',
      video_url: video_url.trim(),
      thumbnail_url: thumbnail_url || 'https://images.unsplash.com/photo-1506126613408-eca07ce68773?auto=format&fit=crop&w=600&q=80',
      order_index: Date.now(),
    };

    CUSTOM_VIDEOS.push(newVideo);

    const { data } = await supabaseAdmin
      .from('yoga_videos')
      .insert(newVideo)
      .select()
      .single();

    res.status(201).json({ video: data || newVideo });
  } catch (err) {
    console.error('Create video class error:', err);
    res.status(500).json({ error: 'Failed to add video class' });
  }
});

/**
 * ADMIN: DELETE /api/wellness/videos/:id
 * Delete a video class.
 */
wellnessRouter.delete('/admin/videos/:id', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const { id } = req.params;
    await supabaseAdmin.from('yoga_videos').delete().eq('id', id);
    res.json({ success: true, message: 'Video class deleted' });
  } catch (err) {
    console.error('Delete video error:', err);
    res.status(500).json({ error: 'Failed to delete video class' });
  }
});

/**
 * GET /api/wellness/sessions
 * Returns all active wellness sessions created by Admin (combining DB and memory)
 */
wellnessRouter.get('/sessions', async (_req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('wellness_sessions')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    const dbSessions = data || [];
    const combined = [...LOCAL_WELLNESS_SESSIONS, ...dbSessions];
    const unique = Array.from(new Map(combined.map(s => [s.id, s])).values());

    res.json({ sessions: unique });
  } catch (err) {
    console.error('Get user wellness sessions error:', err);
    res.json({ sessions: LOCAL_WELLNESS_SESSIONS });
  }
});
