import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth';

export const adminRouter = Router();

// All admin routes require admin role
adminRouter.use(requireAuth);
adminRouter.use(requireRole('admin'));

/**
 * GET /api/admin/doctor-applications
 * Returns pending doctor applications for review.
 */
adminRouter.get('/doctor-applications', async (_req, res) => {
  try {
    // Explicit FK join: user_id -> users.id, and also fetch doctor_documents
    const { data, error } = await supabaseAdmin
      .from('doctor_applications')
      .select('*, users!doctor_applications_user_id_fkey(full_name, email, avatar_url), doctor_documents(file_url, document_type)')
      .order('created_at', { ascending: false });

    if (error) {
      // Fall back to a simpler query without the join
      console.warn('FK join failed, trying simple query:', error.message);
      const { data: simple, error: simpleError } = await supabaseAdmin
        .from('doctor_applications')
        .select('*, doctor_documents(file_url, document_type)')
        .order('created_at', { ascending: false });

      if (simpleError) {
        console.error('Supabase doctor-applications error:', JSON.stringify(simpleError));
        res.status(500).json({ error: 'Failed to fetch applications', detail: simpleError.message });
        return;
      }
      res.json({ applications: simple || [] });
      return;
    }

    res.json({ applications: data || [] });
  } catch (err) {
    console.error('Get applications error:', err);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

/**
 * PATCH /api/admin/doctor-applications/:id
 * Approve or reject a doctor application.
 */
adminRouter.patch('/doctor-applications/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { status, rejection_reason } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'status must be "approved" or "rejected"' });
      return;
    }

    // Get the application
    const { data: application, error: appError } = await supabaseAdmin
      .from('doctor_applications')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (appError || !application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }

    // Update the application status
    await supabaseAdmin
      .from('doctor_applications')
      .update({
        status,
        rejection_reason: rejection_reason || null,
        reviewed_by: req.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    // If approved, create a doctor record and update user role
    if (status === 'approved') {
      await supabaseAdmin.from('doctors').insert({
        user_id: application.user_id,
        specialty: application.specialty,
        experience_years: application.experience_years,
        languages: application.languages,
        consultation_fee: application.consultation_fee,
        consultation_type: application.consultation_type || 'video',
        category: application.category,
        license_number: application.license_number,
        status: 'approved',
      });

      await supabaseAdmin
        .from('users')
        .update({ role: 'doctor' })
        .eq('id', application.user_id);
    } else if (status === 'rejected') {
      // Fetch user to increment rejection count
      const { data: user } = await supabaseAdmin.from('users').select('rejection_count').eq('id', application.user_id).single();
      const newCount = (user?.rejection_count || 0) + 1;
      await supabaseAdmin.from('users').update({ rejection_count: newCount }).eq('id', application.user_id);
    }

    // Audit log
    await supabaseAdmin.from('admin_audit_log').insert({
      admin_id: req.userId,
      action: `doctor_application_${status}`,
      target_type: 'doctor_application',
      target_id: req.params.id,
      details: { rejection_reason },
    });

    res.json({ success: true, status });
  } catch (err) {
    console.error('Review application error:', err);
    res.status(500).json({ error: 'Failed to review application' });
  }
});

/**
 * GET /api/admin/users
 * Returns all users with pagination.
 */
adminRouter.get('/users', async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact' })
      .range(offset, offset + limit - 1)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch users' });
      return;
    }

    res.json({ users: data || [], total: count, page, limit });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * GET /api/admin/content
 * Returns unverified content (posts).
 */
adminRouter.get('/content', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('community_posts')
      .select('*, users!inner(full_name, email)')
      .eq('is_active', false)
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch content' });
      return;
    }

    res.json({ posts: data || [] });
  } catch (err) {
    console.error('Get content error:', err);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
});

/**
 * PATCH /api/admin/content/:id
 * Approve/publish a post.
 */
adminRouter.patch('/content/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { is_active } = req.body;

    const { error } = await supabaseAdmin
      .from('community_posts')
      .update({ is_active })
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to update content status' });
      return;
    }

    // Audit log
    await supabaseAdmin.from('admin_audit_log').insert({
      admin_id: req.userId,
      action: is_active ? 'publish_post' : 'hide_post',
      target_type: 'community_post',
      target_id: req.params.id,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update content error:', err);
    res.status(500).json({ error: 'Failed to update content' });
  }
});

/**
 * GET /api/admin/stats
 * Business analytics overview.
 */
adminRouter.get('/stats', async (_req, res) => {
  try {
    const [users, doctors, appointments, posts] = await Promise.all([
      supabaseAdmin.from('users').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('doctors').select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabaseAdmin.from('appointments').select('id', { count: 'exact', head: true }),
      supabaseAdmin.from('community_posts').select('id', { count: 'exact', head: true }),
    ]);

    res.json({
      total_users: users.count || 0,
      total_doctors: doctors.count || 0,
      total_appointments: appointments.count || 0,
      total_community_posts: posts.count || 0,
    });
  } catch (err) {
    console.error('Get stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/admin/notifications
 * Get all admin notifications.
 */
adminRouter.get('/notifications', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('admin_notifications')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      // Table may not exist yet — return empty gracefully
      console.warn('admin_notifications fetch warning (table may not exist):', error.message);
      res.json({ notifications: [] });
      return;
    }

    res.json({ notifications: data || [] });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.json({ notifications: [] });
  }
});

/**
 * PATCH /api/admin/notifications/:id
 * Mark a notification as read.
 */
adminRouter.patch('/notifications/:id', async (req, res) => {
  try {
    const { is_read } = req.body;
    const { error } = await supabaseAdmin
      .from('admin_notifications')
      .update({ is_read })
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to update notification' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update notification error:', err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

/**
 * GET /api/admin/posts
 * Returns all community posts (both active and inactive) for admin moderation.
 */
adminRouter.get('/posts', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('community_posts')
      .select('*, users!inner(full_name, email)')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch posts for moderation' });
      return;
    }

    res.json({ posts: data || [] });
  } catch (err) {
    console.error('Get admin posts error:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

/**
 * PATCH /api/admin/posts/:id
 * Enable or disable a post (take down / restore).
 */
adminRouter.patch('/posts/:id', async (req, res) => {
  try {
    const { is_active } = req.body;

    const { error } = await supabaseAdmin
      .from('community_posts')
      .update({ is_active })
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to moderate post' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Moderate post error:', err);
    res.status(500).json({ error: 'Failed to moderate post' });
  }
});

/**
 * DELETE /api/admin/comments/:id
 * Delete a comment permanently (take down).
 */
adminRouter.delete('/comments/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('community_comments')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete comment' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

/**
 * POST /api/admin/wellness-sessions
 * Create a new wellness session (admin uploaded).
 */
adminRouter.post('/wellness-sessions', async (req, res) => {
  try {
    const { title, subtitle, duration, type, scheduled_at, thumbnail_url, category } = req.body;

    const { data, error } = await supabaseAdmin
      .from('wellness_sessions')
      .insert({
        title,
        subtitle,
        duration,
        type,
        scheduled_at: scheduled_at || null,
        thumbnail_url,
        category,
        is_active: true
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to create wellness session' });
      return;
    }

    res.status(201).json({ session: data });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * POST /api/admin/articles
 * Create a new article (admin uploaded).
 */
adminRouter.post('/articles', async (req, res) => {
  try {
    const { title, excerpt, content, read_time, image_url, category } = req.body;

    const { data, error } = await supabaseAdmin
      .from('articles')
      .insert({
        title,
        excerpt,
        content: content || null,
        read_time,
        image_url,
        category,
        is_published: true
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to create article' });
      return;
    }

    res.status(201).json({ article: data });
  } catch (err) {
    console.error('Create article error:', err);
    res.status(500).json({ error: 'Failed to create article' });
  }
});

/**
 * GET /api/admin/users
 * List all users with their role and status.
 */
adminRouter.get('/users', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, role, avatar_url, created_at, rejection_count')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch users' });
      return;
    }

    res.json({ users: data || [] });
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * DELETE /api/admin/users/:id
 * Delete a user by admin. Cascades related records.
 */
adminRouter.delete('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    // Delete related records in order
    await supabaseAdmin.from('chat_messages').delete().eq('sender_id', userId);
    await supabaseAdmin.from('chat_conversations').delete().or(`patient_id.eq.${userId},doctor_id.eq.${userId}`);
    await supabaseAdmin.from('community_comments').delete().eq('user_id', userId);
    await supabaseAdmin.from('community_posts').delete().eq('user_id', userId);
    await supabaseAdmin.from('health_records').delete().eq('user_id', userId);
    await supabaseAdmin.from('symptoms').delete().eq('user_id', userId);
    await supabaseAdmin.from('cycle_logs').delete().eq('user_id', userId);
    await supabaseAdmin.from('appointments').delete().or(`patient_id.eq.${userId},doctor_id.eq.${userId}`);
    await supabaseAdmin.from('doctor_documents').delete().in('application_id',
      (await supabaseAdmin.from('doctor_applications').select('id').eq('user_id', userId)).data?.map((a: any) => a.id) || []
    );
    await supabaseAdmin.from('doctor_applications').delete().eq('user_id', userId);
    await supabaseAdmin.from('doctor_availability').delete().in('doctor_id',
      (await supabaseAdmin.from('doctors').select('id').eq('user_id', userId)).data?.map((d: any) => d.id) || []
    );
    await supabaseAdmin.from('doctors').delete().eq('user_id', userId);
    await supabaseAdmin.from('memberships').delete().eq('user_id', userId);
    await supabaseAdmin.from('users').delete().eq('id', userId);

    // Also delete from auth
    await supabaseAdmin.auth.admin.deleteUser(userId);

    res.json({ success: true });
  } catch (err) {
    console.error('Admin delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * GET /api/admin/consultations
 * List all appointments/consultations.
 */
adminRouter.get('/consultations', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('appointments')
      .select('*, patient:users!appointments_patient_id_fkey(full_name, email), doctor:doctors!appointments_doctor_id_fkey(specialty, users!inner(full_name))')
      .order('appointment_date', { ascending: false });

    if (error) {
      console.warn('Consultations join failed, trying simpler query:', error.message);
      const { data: simple, error: simpleError } = await supabaseAdmin
        .from('appointments')
        .select('*')
        .order('appointment_date', { ascending: false });

      if (simpleError) {
        res.status(500).json({ error: 'Failed to fetch consultations' });
        return;
      }
      res.json({ consultations: simple || [] });
      return;
    }

    res.json({ consultations: data || [] });
  } catch (err) {
    console.error('Get consultations error:', err);
    res.status(500).json({ error: 'Failed to fetch consultations' });
  }
});

/**
 * GET /api/admin/programs
 * List all wellness programs.
 */
adminRouter.get('/programs', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('programs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      // programs table may not exist yet
      res.json({ programs: [] });
      return;
    }

    res.json({ programs: data || [] });
  } catch (err) {
    console.error('Get programs error:', err);
    res.json({ programs: [] });
  }
});

/**
 * POST /api/admin/programs
 * Create a new program.
 */
adminRouter.post('/programs', async (req, res) => {
  try {
    const { title, description, duration_weeks, category, is_active } = req.body;

    const { data, error } = await supabaseAdmin
      .from('programs')
      .insert({
        title,
        description,
        duration_weeks,
        category,
        is_active: is_active !== false,
      })
      .select()
      .single();

    if (error) {
      console.error('Create program DB error:', JSON.stringify(error));
      res.status(500).json({ error: 'Failed to create program' });
      return;
    }

    res.status(201).json({ program: data });
  } catch (err) {
    console.error('Create program error:', err);
    res.status(500).json({ error: 'Failed to create program' });
  }
});

/**
 * DELETE /api/admin/programs/:id
 * Delete a program.
 */
adminRouter.delete('/programs/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('programs')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete program' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete program error:', err);
    res.status(500).json({ error: 'Failed to delete program' });
  }
});

/**
 * DELETE /api/admin/posts/:id
 * Permanently delete a community post.
 */
adminRouter.delete('/posts/:id', async (req, res) => {
  try {
    // Delete associated comments first
    await supabaseAdmin.from('community_comments').delete().eq('post_id', req.params.id);

    const { error } = await supabaseAdmin
      .from('community_posts')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete post' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete post error:', err);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});
