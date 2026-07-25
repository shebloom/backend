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
      .select('*, users(full_name, avatar_url)')
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
    const postId = req.params.id as string;
    const { data: post, error: postError } = await supabaseAdmin
      .from('community_posts')
      .select('*, users(full_name, avatar_url)')
      .eq('id', postId)
      .single();

    if (postError || !post) {
      res.status(404).json({ error: 'Post not found' });
      return;
    }

    let finalComments: any[] = [];

    // Attempt 1: Fetch top-level comments (where parent_id is null and not hidden)
    const { data: topLevelComments, error: commentsError } = await supabaseAdmin
      .from('community_comments')
      .select('*, users(full_name, avatar_url)')
      .eq('post_id', postId)
      .is('parent_id', null)
      .or('is_hidden.eq.false,is_hidden.is.null')
      .order('created_at', { ascending: true });

    if (commentsError) {
      console.warn(`[community] GET /posts/${postId} — primary comment fetch error (schema columns may be missing): ${commentsError.message}`);
      
      // Fallback Attempt: Select all comments for this post without filtering by parent_id or is_hidden
      const { data: fallbackComments, error: fallbackErr } = await supabaseAdmin
        .from('community_comments')
        .select('*, users(full_name, avatar_url)')
        .eq('post_id', postId)
        .order('created_at', { ascending: true });

      if (fallbackErr) {
        console.error(`[community] GET /posts/${postId} — fallback comment fetch error:`, fallbackErr.message);
        finalComments = [];
      } else {
        finalComments = (fallbackComments || []).map((c: any) => ({ ...c, replies: c.replies || [] }));
      }
    } else {
      const topComments = topLevelComments || [];

      // For each comment, fetch visible replies
      finalComments = await Promise.all(
        topComments.map(async (comment: any) => {
          const { data: replies, error: repliesError } = await supabaseAdmin
            .from('community_comments')
            .select('*, users(full_name, avatar_url)')
            .eq('post_id', postId)
            .eq('parent_id', comment.id)
            .or('is_hidden.eq.false,is_hidden.is.null')
            .order('created_at', { ascending: true });

          if (repliesError) {
            console.error(`[community] Replies fetch error for comment ${comment.id}:`, repliesError.message);
          }

          return { ...comment, replies: replies || [] };
        })
      );
    }

    res.json({ post, comments: finalComments });
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
      .select('full_name, avatar_url')
      .eq('id', req.userId)
      .maybeSingle();

    const formattedPost = {
      ...newPost,
      users: author || { full_name: 'Community Member', avatar_url: null },
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
    const postId = req.params.id as string;

    if (!content) {
      res.status(400).json({ error: 'content is required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('community_comments')
      .insert({
        post_id: postId,
        user_id: req.userId,
        content,
        parent_id: null,
        is_hidden: false,
      })
      .select('*, users(full_name, avatar_url)')
      .single();

    if (error) {
      // Fallback without new columns if they don't exist yet
      console.warn('[community] Comment insert (full schema) failed, trying fallback:', error.message);
      const { data: fallback, error: fallbackError } = await supabaseAdmin
        .from('community_comments')
        .insert({
          post_id: postId,
          user_id: req.userId,
          content,
        })
        .select('*, users(full_name, avatar_url)')
        .single();

      if (fallbackError) {
        console.error('[community] Fallback comment insert also failed:', fallbackError.message);
        res.status(500).json({ error: 'Failed to add comment' });
        return;
      }

      await recalculatePostCommentCount(postId);
      res.status(201).json({ comment: { ...fallback, replies: [] } });
      return;
    }

    await recalculatePostCommentCount(postId);
    res.status(201).json({ comment: { ...data, replies: [] } });
  } catch (err) {
    console.error('[community] Add comment error:', err);
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
      const postId = req.params.id as string;
      const commentId = req.params.commentId as string;

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
        console.warn(`[community] Parent comment not found — commentId=${commentId} postId=${postId}`);
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
        console.error('[community] Reply DB insert error:', error.message, '| post_id:', postId, '| parent_id:', commentId);
        res.status(500).json({ error: 'Failed to add reply' });
        return;
      }

      if (!data) {
        console.error('[community] Reply insert returned no data despite no error — possible RLS or schema issue');
        res.status(500).json({ error: 'Reply was not saved — no record returned from database' });
        return;
      }

      // Recalculate comment count on post
      await recalculatePostCommentCount(postId);

      res.status(201).json({ reply: data });
    } catch (err) {
      console.error('[community] Add reply error:', err);
      res.status(500).json({ error: 'Failed to add reply' });
    }
  }
);

/**
 * Helper to recalculate comment count for a specific post
 */
export async function recalculatePostCommentCount(postId: string): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from('community_comments')
      .select('*', { count: 'exact', head: true })
      .eq('post_id', postId);

    if (error) {
      console.error(`[community] Error counting comments for post ${postId}:`, error.message);
      return 0;
    }

    const commentCount = count || 0;

    const { error: updateErr } = await supabaseAdmin
      .from('community_posts')
      .update({ comments: commentCount })
      .eq('id', postId);

    if (updateErr) {
      console.error(`[community] Error updating post comment count for ${postId}:`, updateErr.message);
    }

    return commentCount;
  } catch (err) {
    console.error(`[community] Recalculate error for post ${postId}:`, err);
    return 0;
  }
}

/**
 * Helper to recalculate comment count for all posts in DB
 */
export async function recalculateAllPostCommentCounts(): Promise<void> {
  try {
    const { data: posts, error } = await supabaseAdmin
      .from('community_posts')
      .select('id');

    if (error || !posts) {
      console.error('[community] Failed to fetch posts for reconciliation:', error?.message);
      return;
    }

    for (const post of posts) {
      await recalculatePostCommentCount(post.id);
    }
  } catch (err) {
    console.error('[community] Global reconciliation failed:', err);
  }
}

/**
 * POST /api/community/recalculate-comment-counts
 * Endpoint to trigger comment count reconciliation across all posts.
 */
communityRouter.post('/recalculate-comment-counts', async (_req, res) => {
  try {
    await recalculateAllPostCommentCounts();
    res.json({ success: true, message: 'All post comment counts have been reconciled with actual comment rows.' });
  } catch (err) {
    console.error('Recalculate route error:', err);
    res.status(500).json({ error: 'Failed to recalculate comment counts' });
  }
});

