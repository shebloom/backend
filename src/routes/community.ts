import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const communityRouter = Router();

/**
 * GET /api/community/posts
 * Returns community posts. Supports ?topic= filter.
 */
communityRouter.get('/posts', async (req, res) => {
  try {
    const { topic } = req.query;

    let query = supabaseAdmin
      .from('community_posts')
      .select('*, users!inner(full_name, avatar_url, location)')
      .eq('is_active', true);

    if (topic && topic !== 'All') {
      query = query.eq('topic', topic);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch posts' });
      return;
    }

    res.json({ posts: data || [] });
  } catch (err) {
    console.error('Get posts error:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

/**
 * GET /api/community/posts/:id
 * Returns a single post with its comments.
 */
communityRouter.get('/posts/:id', async (req, res) => {
  try {
    const { data: post, error: postError } = await supabaseAdmin
      .from('community_posts')
      .select('*, users!inner(full_name, avatar_url, location)')
      .eq('id', req.params.id)
      .single();

    if (postError || !post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    const { data: comments } = await supabaseAdmin
      .from('community_comments')
      .select('*, users!inner(full_name, avatar_url)')
      .eq('post_id', req.params.id)
      .order('created_at', { ascending: true });

    res.json({ post, comments: comments || [] });
  } catch (err) {
    console.error('Get post error:', err);
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

/**
 * POST /api/community/posts
 * Create a new post.
 */
communityRouter.post('/posts', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { title, content, topic } = req.body;

    if (!title || !topic) {
      res.status(400).json({ error: 'title and topic are required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('community_posts')
      .insert({
        user_id: req.userId,
        title,
        content: content || null,
        topic,
        is_active: true // Active immediately, can be taken down by admin
      })
      .select('*, users!inner(full_name, avatar_url, location)')
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to create post' });
      return;
    }

    try {
      // Fetch author name
      const { data: author } = await supabaseAdmin
        .from('users')
        .select('full_name')
        .eq('id', req.userId)
        .single();
      
      // Notify Admin
      await supabaseAdmin
        .from('admin_notifications')
        .insert({
          title: 'New Community Conversation',
          message: `${author?.full_name || 'A member'} started a new discussion: "${title}"`,
          type: 'new_post',
          target_id: data.id,
          is_read: false
        });
    } catch (notifErr) {
      console.error('Failed to create admin notification:', notifErr);
    }

    res.status(201).json({ post: data });
  } catch (err) {
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

/**
 * POST /api/community/posts/:id/like
 * Toggle like on a post.
 */
communityRouter.post('/posts/:id/like', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    // Check if already liked
    const { data: existing } = await supabaseAdmin
      .from('post_likes')
      .select('id')
      .eq('post_id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (existing) {
      // Unlike
      await supabaseAdmin
        .from('post_likes')
        .delete()
        .eq('post_id', req.params.id)
        .eq('user_id', req.userId);

      await supabaseAdmin.rpc('decrement_likes', { post_id_input: req.params.id });
      res.json({ liked: false });
    } else {
      // Like
      await supabaseAdmin
        .from('post_likes')
        .insert({ post_id: req.params.id, user_id: req.userId });

      await supabaseAdmin.rpc('increment_likes', { post_id_input: req.params.id });
      res.json({ liked: true });
    }
  } catch (err) {
    console.error('Like error:', err);
    res.status(500).json({ error: 'Failed to toggle like' });
  }
});

/**
 * POST /api/community/posts/:id/comments
 * Add a comment to a post.
 */
communityRouter.post('/posts/:id/comments', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('community_comments')
      .insert({
        post_id: req.params.id,
        user_id: req.userId,
        content,
      })
      .select('*, users!inner(full_name, avatar_url)')
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to add comment' });
      return;
    }

    // Increment comment count
    await supabaseAdmin.rpc('increment_comments', { post_id_input: req.params.id });

    res.status(201).json({ comment: data });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});
