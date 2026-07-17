import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';

export const articlesRouter = Router();

/**
 * GET /api/articles
 * Returns all published articles. Supports ?category= filter.
 */
articlesRouter.get('/', async (req, res) => {
  try {
    const { category } = req.query;

    let query = supabaseAdmin
      .from('articles')
      .select('*')
      .eq('is_published', true);

    if (category) query = query.eq('category', category);

    const { data, error } = await query.order('published_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch articles' });
      return;
    }

    res.json({ articles: data || [] });
  } catch (err) {
    console.error('Get articles error:', err);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

/**
 * GET /api/articles/:id
 */
articlesRouter.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('articles')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }

    res.json({ article: data });
  } catch (err) {
    console.error('Get article error:', err);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});
