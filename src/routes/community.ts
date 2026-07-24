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
      .select('*, users(full_name, avatar_url, location)')
      .eq('is_active', true);

    if (topic && topic !== 'All') {
      query = query.eq('topic', topic);
    }

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.warn('GET /posts join error, attempting fallback query:', error.message);
      const { data: fallbackData } = await supabaseAdmin
        .from('community_posts')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      res.json({ posts: fallbackData || [] });
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
 * Returns a single post with its top-level comments and their replies.
 * Hidden comments/replies are excluded for regular users.
 */
communityRouter.get('/posts/:id', async (req, res) => {
  try {
    const { data: post, error: postError } = await supabaseAdmin
      .from('community_posts')
      .select('*, users(full_name, avatar_url, location)')
      .eq('id', req.params.id)
      .single();

    if (postError || !post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    // Fetch top-level comments (no parent_id) — exclude hidden ones for public view
    const { data: topLevelComments } = await supabaseAdmin
      .from('community_comments')
      .select('*, users(full_name, avatar_url)')
      .eq('post_id', req.params.id)
      .is('parent_id', null)
      .eq('is_hidden', false)
      .order('created_at', { ascending: true });

    const comments = topLevelComments || [];

    // For each comment, fetch visible replies
    const commentsWithReplies = await Promise.all(
      comments.map(async (comment: any) => {
        const { data: replies } = await supabaseAdmin
          .from('community_comments')
          .select('*, users(full_name, avatar_url)')
          .eq('post_id', req.params.id)
          .eq('parent_id', comment.id)
          .eq('is_hidden', false)
          .order('created_at', { ascending: true });

        return { ...comment, replies: replies || [] };
      })
    );

    res.json({ post, comments: commentsWithReplies });
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

    const { data: newPost, error } = await supabaseAdmin
      .from('community_posts')
      .insert({
        user_id: req.userId,
        title: title.trim(),
        content: content ? content.trim() : null,
        topic: topic.trim(),
        is_active: true,
      })
      .select('*')
      .single();

    if (error || !newPost) {
      console.error('Create post DB error:', error);
      res.status(500).json({ error: error?.message || 'Failed to create post' });
      return;
    }

    const { data: author } = await supabaseAdmin
      .from('users')
      .select('full_name, avatar_url, location')
      .eq('id', req.userId)
      .maybeSingle();

    const formattedPost = {
      ...newPost,
      users: author || { full_name: 'Community Member', avatar_url: null, location: null },
    };

    try {
      await supabaseAdmin
        .from('admin_notifications')
        .insert({
          title: 'New Community Conversation',
          message: `${author?.full_name || 'A member'} started a new discussion: "${title}"`,
          type: 'new_post',
          target_id: newPost.id,
          is_read: false,
        });
    } catch (notifErr) {
      console.warn('Admin notification insert skipped:', notifErr);
    }

    res.status(201).json({ post: formattedPost });
  } catch (err: any) {
    console.error('Create post error:', err);
    res.status(500).json({ error: err?.message || 'Failed to create post' });
  }
});

/**
 * POST /api/community/posts/:id/like
 * Toggle like on a post.
 */
communityRouter.post('/posts/:id/like', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data: existing } = await supabaseAdmin
      .from('post_likes')
      .select('id')
      .eq('post_id', req.params.id)
      .eq('user_id', req.userId)
      .single();

    if (existing) {
      await supabaseAdmin
        .from('post_likes')
        .delete()
        .eq('post_id', req.params.id)
        .eq('user_id', req.userId);

      await supabaseAdmin.rpc('decrement_likes', { post_id_input: req.params.id });
      res.json({ liked: false });
    } else {
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
 * Add a top-level comment to a post.
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
        parent_id: null,
        is_hidden: false,
      })
      .select('*, users(full_name, avatar_url)')
      .single();

    if (error) {
      // Fallback without new columns if they don't exist yet
      console.warn('Comment insert with new columns failed, trying fallback:', error.message);
      const { data: fallback, error: fallbackError } = await supabaseAdmin
        .from('community_comments')
        .insert({
          post_id: req.params.id,
          user_id: req.userId,
          content,
        })
        .select('*, users(full_name, avatar_url)')
        .single();

      if (fallbackError) {
        res.status(500).json({ error: 'Failed to add comment' });
        return;
      }

      await supabaseAdmin.rpc('increment_comments', { post_id_input: req.params.id });
      res.status(201).json({ comment: { ...fallback, replies: [] } });
      return;
    }

    await supabaseAdmin.rpc('increment_comments', { post_id_input: req.params.id });
    res.status(201).json({ comment: { ...data, replies: [] } });
  } catch (err) {
    console.error('Add comment error:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

/**
 * POST /api/community/posts/:id/comments/:commentId/replies
 * Add a reply to an existing comment.
 */
communityRouter.post(
  '/posts/:id/comments/:commentId/replies',
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { content } = req.body;
      const { id: postId, commentId } = req.params;

      if (!content) {
        res.status(400).json({ error: 'content is required' });
        return;
      }

      // Verify parent comment exists and belongs to this post
      const { data: parentComment, error: parentError } = await supabaseAdmin
        .from('community_comments')
        .select('id, post_id')
        .eq('id', commentId)
        .eq('post_id', postId)
        .single();

      if (parentError || !parentComment) {
        res.status(404).json({ error: 'Parent comment not found' });
        return;
      }

      const { data, error } = await supabaseAdmin
        .from('community_comments')
        .insert({
          post_id: postId,
          user_id: req.userId,
          content,
          parent_id: commentId,
          is_hidden: false,
        })
        .select('*, users(full_name, avatar_url)')
        .single();

      if (error) {
        console.error('Reply insert error:', error);
        res.status(500).json({ error: 'Failed to add reply' });
        return;
      }

      // Increment comment count on the post for replies too
      await supabaseAdmin.rpc('increment_comments', { post_id_input: postId });

      res.status(201).json({ reply: data });
    } catch (err) {
      console.error('Add reply error:', err);
      res.status(500).json({ error: 'Failed to add reply' });
    }
  }
);
