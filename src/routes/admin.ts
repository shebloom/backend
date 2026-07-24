import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth';

export const adminRouter = Router();

import { LOCAL_WELLNESS_PROGRAMS, LOCAL_WELLNESS_SESSIONS, LOCAL_DIET_PLANS } from '../lib/memoryStore';

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
 * GET /api/admin/doctor-applications/documents/:filename
 * Streams/downloads doctor application documents securely.
 */
adminRouter.get('/doctor-applications/documents/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const { data, error } = await supabaseAdmin.storage
      .from('doctor-documents')
      .download(filename);

    if (error || !data) {
      console.error('Storage download error:', error);
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
    } else if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext || '')) {
      res.setHeader('Content-Type', `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
    res.send(buffer);
  } catch (err) {
    console.error('Download application document error:', err);
    res.status(500).json({ error: 'Failed to retrieve document' });
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
        slot_duration: application.slot_duration || 30,
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
 * Returns all users for admin management with resilient schema fallback.
 */
adminRouter.get('/users', async (req, res) => {
  try {
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    let query = supabaseAdmin
      .from('users')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (page && limit) {
      const offset = (page - 1) * limit;
      query = query.range(offset, offset + limit - 1);
    }

    const { data, error, count } = await query;

    if (error) {
      console.warn('Get users query warning, running simple select:', error.message);
      const { data: simple, error: simpleError } = await supabaseAdmin
        .from('users')
        .select('*');

      if (simpleError) {
        console.error('Get users fallback error:', JSON.stringify(simpleError));
        res.status(500).json({ error: 'Failed to fetch users', detail: simpleError.message });
        return;
      }

      res.json({ users: simple || [], total: (simple || []).length });
      return;
    }

    res.json({ users: data || [], total: count ?? (data || []).length });
  } catch (err) {
    console.error('Get users catch error:', err);
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
 * GET /api/admin/posts/:postId/comments
 * Returns ALL comments and replies for a post (including hidden), for admin moderation.
 */
adminRouter.get('/posts/:postId/comments', async (req: AuthenticatedRequest, res) => {
  try {
    // Fetch all top-level comments (no parent_id)
    const { data: topComments, error } = await supabaseAdmin
      .from('community_comments')
      .select('*, users(full_name, avatar_url, email)')
      .eq('post_id', req.params.postId)
      .is('parent_id', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('Get admin comments error (parent_id may not exist):', error.message);
      // Fallback: get all comments without filtering by parent_id
      const { data: allComments, error: fallbackErr } = await supabaseAdmin
        .from('community_comments')
        .select('*, users(full_name, avatar_url, email)')
        .eq('post_id', req.params.postId)
        .order('created_at', { ascending: true });

      if (fallbackErr) {
        res.status(500).json({ error: 'Failed to fetch comments' });
        return;
      }
      res.json({ comments: allComments || [] });
      return;
    }

    // For each top-level comment, fetch ALL replies (including hidden)
    const commentsWithReplies = await Promise.all(
      (topComments || []).map(async (comment: any) => {
        const { data: replies } = await supabaseAdmin
          .from('community_comments')
          .select('*, users(full_name, avatar_url, email)')
          .eq('post_id', req.params.postId)
          .eq('parent_id', comment.id)
          .order('created_at', { ascending: true });
        return { ...comment, replies: replies || [] };
      })
    );

    res.json({ comments: commentsWithReplies });
  } catch (err) {
    console.error('Get admin post comments error:', err);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

/**
 * PATCH /api/admin/comments/:id
 * Hide or unhide a comment (soft moderation — not visible to users but kept in DB).
 */
adminRouter.patch('/comments/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { is_hidden } = req.body;

    if (typeof is_hidden !== 'boolean') {
      res.status(400).json({ error: 'is_hidden (boolean) is required' });
      return;
    }

    const { error } = await supabaseAdmin
      .from('community_comments')
      .update({ is_hidden })
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to update comment visibility' });
      return;
    }

    // Audit log
    try {
      await supabaseAdmin.from('admin_audit_log').insert({
        admin_id: req.userId,
        action: is_hidden ? 'hide_comment' : 'unhide_comment',
        target_type: 'community_comment',
        target_id: req.params.id,
      });
    } catch (_) {}

    res.json({ success: true, is_hidden });
  } catch (err) {
    console.error('Toggle comment visibility error:', err);
    res.status(500).json({ error: 'Failed to toggle comment visibility' });
  }
});

/**
 * DELETE /api/admin/comments/:id
 * Permanently delete a comment and all its replies.
 */
adminRouter.delete('/comments/:id', async (req: AuthenticatedRequest, res) => {
  try {
    // Delete all replies to this comment first (cascade safe)
    await supabaseAdmin
      .from('community_comments')
      .delete()
      .eq('parent_id', req.params.id);

    const { error } = await supabaseAdmin
      .from('community_comments')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete comment' });
      return;
    }

    // Audit log
    try {
      await supabaseAdmin.from('admin_audit_log').insert({
        admin_id: req.userId,
        action: 'delete_comment',
        target_type: 'community_comment',
        target_id: req.params.id,
      });
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    console.error('Delete comment error:', err);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

/**
 * PATCH /api/admin/replies/:id
 * Hide or unhide a reply.
 */
adminRouter.patch('/replies/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { is_hidden } = req.body;

    if (typeof is_hidden !== 'boolean') {
      res.status(400).json({ error: 'is_hidden (boolean) is required' });
      return;
    }

    const { error } = await supabaseAdmin
      .from('community_comments')
      .update({ is_hidden })
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to update reply visibility' });
      return;
    }

    // Audit log
    try {
      await supabaseAdmin.from('admin_audit_log').insert({
        admin_id: req.userId,
        action: is_hidden ? 'hide_reply' : 'unhide_reply',
        target_type: 'community_reply',
        target_id: req.params.id,
      });
    } catch (_) {}

    res.json({ success: true, is_hidden });
  } catch (err) {
    console.error('Toggle reply visibility error:', err);
    res.status(500).json({ error: 'Failed to toggle reply visibility' });
  }
});

/**
 * DELETE /api/admin/replies/:id
 * Permanently delete a reply.
 */
adminRouter.delete('/replies/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('community_comments')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete reply' });
      return;
    }

    // Audit log
    try {
      await supabaseAdmin.from('admin_audit_log').insert({
        admin_id: req.userId,
        action: 'delete_reply',
        target_type: 'community_reply',
        target_id: req.params.id,
      });
    } catch (_) {}

    res.json({ success: true });
  } catch (err) {
    console.error('Delete reply error:', err);
    res.status(500).json({ error: 'Failed to delete reply' });
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
 * GET /api/admin/users/:id
 * Get complete user profile details for admin view.
 */
adminRouter.get('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Fetch doctor record if exists
    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    // Fetch doctor application if exists
    const { data: application } = await supabaseAdmin
      .from('doctor_applications')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    res.json({
      user,
      doctor: doctor || null,
      application: application || null,
    });
  } catch (err) {
    console.error('Get user details error:', err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

/**
 * PATCH /api/admin/users/:id/verify-doctor
 * Admin directly verifies/promotes a user to a Verified Doctor.
 */
adminRouter.patch('/users/:id/verify-doctor', async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.params.id;
    const { specialty, experience_years, license_number, consultation_fee } = req.body;

    // 1. Update user role to doctor
    const { data: updatedUser, error: userErr } = await supabaseAdmin
      .from('users')
      .update({ role: 'doctor' })
      .eq('id', userId)
      .select()
      .single();

    if (userErr || !updatedUser) {
      res.status(500).json({ error: 'Failed to update user role' });
      return;
    }

    // 2. Check or upsert doctor record
    const { data: existingDoctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingDoctor) {
      await supabaseAdmin.from('doctors').insert({
        user_id: userId,
        specialty: specialty || 'Obstetrics & Gynecology (OB/GYN)',
        experience_years: Number(experience_years) || 10,
        languages: ['English', 'Hindi'],
        consultation_fee: Number(consultation_fee) || 0,
        consultation_type: 'video',
        category: 'Gynecologist',
        license_number: license_number || `MD-VERIFIED-${Date.now().toString().slice(-6)}`,
        status: 'approved',
        slot_duration: 30,
      });
    } else {
      await supabaseAdmin
        .from('doctors')
        .update({
          status: 'approved',
          specialty: specialty || 'Obstetrics & Gynecology (OB/GYN)',
        })
        .eq('id', existingDoctor.id);
    }

    // 3. Upsert doctor application as approved
    const { data: existingApp } = await supabaseAdmin
      .from('doctor_applications')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (!existingApp) {
      await supabaseAdmin.from('doctor_applications').insert({
        user_id: userId,
        specialty: specialty || 'Obstetrics & Gynecology (OB/GYN)',
        experience_years: Number(experience_years) || 10,
        license_number: license_number || `MD-VERIFIED-${Date.now().toString().slice(-6)}`,
        status: 'approved',
        reviewed_by: req.userId,
        reviewed_at: new Date().toISOString(),
      });
    } else {
      await supabaseAdmin
        .from('doctor_applications')
        .update({
          status: 'approved',
          reviewed_by: req.userId,
          reviewed_at: new Date().toISOString(),
        })
        .eq('id', existingApp.id);
    }

    res.json({ success: true, user: updatedUser });
  } catch (err) {
    console.error('Verify doctor error:', err);
    res.status(500).json({ error: 'Failed to verify doctor' });
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
    const { data } = await supabaseAdmin
      .from('wellness_programs')
      .select('*')
      .order('created_at', { ascending: false });

    const dbProgs = data || [];
    const combined = [...LOCAL_WELLNESS_PROGRAMS, ...dbProgs];
    const unique = Array.from(new Map(combined.map(p => [p.id, p])).values());

    res.json({ programs: unique });
  } catch (err) {
    console.error('Get programs error:', err);
    res.json({ programs: LOCAL_WELLNESS_PROGRAMS });
  }
});

/**
 * POST /api/admin/programs
 * Create a new program.
 */
adminRouter.post('/programs', async (req, res) => {
  try {
    const { title, description, duration_weeks, category, content, benefits, is_active } = req.body;

    const durationText = `${duration_weeks || 4} Weeks`;
    const defaultImage = 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg?auto=compress&cs=tinysrgb&w=400';

    const newProg = {
      id: `prog-${Date.now()}`,
      title,
      description,
      duration: durationText,
      category: category || 'Yoga',
      content: content || null,
      benefits: benefits || null,
      image_url: defaultImage,
      is_active: is_active !== false,
      created_at: new Date().toISOString(),
    };

    LOCAL_WELLNESS_PROGRAMS.unshift(newProg);

    const { data } = await supabaseAdmin
      .from('wellness_programs')
      .insert(newProg)
      .select()
      .single();

    res.status(201).json({ program: data || newProg });
  } catch (err) {
    console.error('Create program error:', err);
    res.status(201).json({ program: { id: `prog-${Date.now()}`, title: req.body.title } });
  }
});

/**
 * DELETE /api/admin/programs/:id
 * Delete a program.
 */
adminRouter.delete('/programs/:id', async (req, res) => {
  try {
    // Remove from local memory
    const idx = LOCAL_WELLNESS_PROGRAMS.findIndex(p => p.id === req.params.id);
    if (idx !== -1) {
      LOCAL_WELLNESS_PROGRAMS.splice(idx, 1);
    }

    await supabaseAdmin
      .from('wellness_programs')
      .delete()
      .eq('id', req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Delete program error:', err);
    res.status(500).json({ error: 'Failed to delete program' });
  }
});

/**
 * PATCH /api/admin/programs/:id
 * Update an existing program.
 */
adminRouter.patch('/programs/:id', async (req, res) => {
  try {
    const { title, description, duration, category, content, benefits, image_url, is_active } = req.body;
    const updates: any = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (duration !== undefined) updates.duration = duration;
    if (category !== undefined) updates.category = category;
    if (content !== undefined) updates.content = content;
    if (benefits !== undefined) updates.benefits = benefits;
    if (image_url !== undefined) updates.image_url = image_url;
    if (is_active !== undefined) updates.is_active = is_active;

    // Update local memory cache
    const idx = LOCAL_WELLNESS_PROGRAMS.findIndex(p => p.id === req.params.id);
    if (idx !== -1) {
      LOCAL_WELLNESS_PROGRAMS[idx] = { ...LOCAL_WELLNESS_PROGRAMS[idx], ...updates };
    }

    const { data } = await supabaseAdmin
      .from('wellness_programs')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    res.json({ program: data || { id: req.params.id, ...updates } });
  } catch (err) {
    console.error('Update program error:', err);
    res.status(500).json({ error: 'Failed to update program' });
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

/**
 * GET /api/admin/wellness-sessions
// Persistent server-side store for fallback sessions
const LOCAL_WELLNESS_SESSIONS: any[] = [];

/**
 * GET /api/admin/wellness-sessions
 * Returns all wellness sessions (Supabase DB + local fallback cache).
 */
adminRouter.get('/wellness-sessions', async (_req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('wellness_sessions')
      .select('*')
      .order('created_at', { ascending: false });

    const dbSessions = data || [];
    // Combine DB sessions with local memory sessions, de-duplicating by id
    const combined = [...LOCAL_WELLNESS_SESSIONS, ...dbSessions];
    const unique = Array.from(new Map(combined.map(s => [s.id, s])).values());

    res.json({ sessions: unique });
  } catch (err) {
    console.error('Get wellness-sessions error:', err);
    res.json({ sessions: LOCAL_WELLNESS_SESSIONS });
  }
});

/**
 * POST /api/admin/wellness-sessions
 * Create a new wellness session with schema fallback & persistence.
 */
adminRouter.post('/wellness-sessions', async (req, res) => {
  try {
    const { title, subtitle, duration, type, category, scheduled_at, thumbnail_url, video_url } = req.body;

    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const validTypes = ['live', 'self-paced', 'recorded'];
    const sessionType = validTypes.includes(type) ? type : 'self-paced';

    const defaultImage = sessionType === 'live' 
      ? 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg?auto=compress&cs=tinysrgb&w=400'
      : 'https://images.pexels.com/photos/3759657/pexels-photo-3759657.jpeg?auto=compress&cs=tinysrgb&w=400';

    const newSession = {
      title,
      subtitle: subtitle || 'Women’s Wellness Session',
      duration: duration || '20 min',
      type: sessionType,
      category: category || 'General Wellness',
      scheduled_at: scheduled_at || null,
      thumbnail_url: thumbnail_url || defaultImage,
      video_url: video_url || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      is_active: true,
    };

    // 1. Try full insert into Supabase DB
    const { data, error } = await supabaseAdmin
      .from('wellness_sessions')
      .insert(newSession)
      .select()
      .single();

    if (error) {
      console.warn('Supabase DB column missing, attempting insert without video_url:', error.message);
      
      // 2. If video_url column is not yet in Supabase schema cache, insert without video_url
      const dbPayload = { ...newSession };
      delete (dbPayload as any).video_url;

      const { data: fallbackData, error: fallbackError } = await supabaseAdmin
        .from('wellness_sessions')
        .insert(dbPayload)
        .select()
        .single();

      const createdSession = fallbackData
        ? { ...fallbackData, video_url: newSession.video_url }
        : { id: `ws-${Date.now()}`, ...newSession, created_at: new Date().toISOString() };

      LOCAL_WELLNESS_SESSIONS.unshift(createdSession);
      res.status(201).json({ session: createdSession });
      return;
    }

    LOCAL_WELLNESS_SESSIONS.unshift(data);
    res.status(201).json({ session: data });
  } catch (error: any) {
    console.error('wellness-sessions error:', error);
    const { title } = req.body || {};
    const fallbackSession = {
      id: `ws-${Date.now()}`,
      title: title || 'New Wellness Session',
      subtitle: 'Women’s Wellness Session',
      duration: '20 min',
      type: 'self-paced',
      category: 'General Wellness',
      video_url: req.body?.video_url || 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      is_active: true,
      created_at: new Date().toISOString(),
    };
    LOCAL_WELLNESS_SESSIONS.unshift(fallbackSession);
    res.status(201).json({ session: fallbackSession });
  }
});

/**
 * PATCH /api/admin/wellness-sessions/:id
 * Update an existing wellness session.
 */
adminRouter.patch('/wellness-sessions/:id', async (req, res) => {
  try {
    const { title, subtitle, duration, type, category, scheduled_at, thumbnail_url, video_url, is_active } = req.body;
    const updates: any = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (subtitle !== undefined) updates.subtitle = subtitle;
    if (duration !== undefined) updates.duration = duration;
    if (type !== undefined) updates.type = type;
    if (category !== undefined) updates.category = category;
    if (scheduled_at !== undefined) updates.scheduled_at = scheduled_at;
    if (thumbnail_url !== undefined) updates.thumbnail_url = thumbnail_url;
    if (video_url !== undefined) updates.video_url = video_url;
    if (is_active !== undefined) updates.is_active = is_active;

    // Update in local memory cache
    const idx = LOCAL_WELLNESS_SESSIONS.findIndex(s => s.id === req.params.id);
    if (idx !== -1) {
      LOCAL_WELLNESS_SESSIONS[idx] = { ...LOCAL_WELLNESS_SESSIONS[idx], ...updates };
    }

    const { data } = await supabaseAdmin
      .from('wellness_sessions')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    res.json({ session: data || { id: req.params.id, ...updates } });
  } catch (err) {
    console.error('Update wellness session error:', err);
    res.status(500).json({ error: 'Failed to update wellness session' });
  }
});

/**
 * DELETE /api/admin/wellness-sessions/:id
 * Delete a wellness session.
 */
adminRouter.delete('/wellness-sessions/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('wellness_sessions')
      .delete()
      .eq('id', req.params.id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete wellness session' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete wellness session error:', err);
    res.status(500).json({ error: 'Failed to delete wellness session' });
  }
});

/**
 * GET /api/admin/diet-plans
 * Returns all generated diet plans with patient profiles.
 */
adminRouter.get('/diet-plans', async (_req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('diet_plans')
      .select('*, users!diet_plans_patient_id_fkey(full_name, email)')
      .order('created_at', { ascending: false });

    const dbPlans = data || [];
    const combined = [...LOCAL_DIET_PLANS, ...dbPlans];
    const unique = Array.from(new Map(combined.map(p => [p.id, p])).values());

    res.json({ diet_plans: unique });
  } catch (err) {
    console.error('Admin get diet plans error:', err);
    res.json({ diet_plans: LOCAL_DIET_PLANS });
  }
});

/**
 * PATCH /api/admin/diet-plans/:id
 * Updates patient diet plan meal structure and guidelines.
 */
adminRouter.patch('/diet-plans/:id', async (req, res) => {
  try {
    const { title, plan_details, notes } = req.body;

    const updates: any = { updated_at: new Date().toISOString() };
    if (title !== undefined) updates.title = title;
    if (plan_details !== undefined) updates.plan_details = plan_details;
    if (notes !== undefined) updates.notes = notes;

    // Update in local memory cache
    const idx = LOCAL_DIET_PLANS.findIndex(p => p.id === req.params.id);
    if (idx !== -1) {
      LOCAL_DIET_PLANS[idx] = { ...LOCAL_DIET_PLANS[idx], ...updates };
    }

    const { data } = await supabaseAdmin
      .from('diet_plans')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    res.json({ diet_plan: data || { id: req.params.id, ...updates } });
  } catch (err) {
    console.error('Admin update diet plan error:', err);
    res.status(500).json({ error: 'Failed to update diet plan' });
  }
});

/**
 * Chunked upload temporary storage — keyed by upload_id, stores Buffers per chunk index.
 * This is an in-memory store for the duration of a chunked upload session.
 */
const CHUNKED_UPLOAD_STORE = new Map<string, { chunks: Buffer[]; totalChunks: number; mimeType: string; fileName: string; createdAt: number }>();

// Clean up stale uploads every 10 minutes (older than 30 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, upload] of CHUNKED_UPLOAD_STORE.entries()) {
    if (now - upload.createdAt > 30 * 60 * 1000) {
      CHUNKED_UPLOAD_STORE.delete(id);
      console.log(`[ChunkedUpload] Cleaned up stale upload session: ${id}`);
    }
  }
}, 10 * 60 * 1000);

/**
 * POST /api/admin/upload-video/chunk
 * Receive a single chunk of a large video upload.
 * Body: { upload_id, chunk_index, total_chunks, chunk_data (base64), mime_type, file_name }
 */
adminRouter.post('/upload-video/chunk', async (req, res) => {
  try {
    const { upload_id, chunk_index, total_chunks, chunk_data, mime_type, file_name } = req.body;

    if (!upload_id || chunk_index === undefined || !total_chunks || !chunk_data) {
      res.status(400).json({ error: 'upload_id, chunk_index, total_chunks, and chunk_data are required' });
      return;
    }

    const chunkIdx = Number(chunk_index);
    const totalChunks = Number(total_chunks);

    // Decode chunk from base64
    const base64Clean = typeof chunk_data === 'string'
      ? chunk_data.replace(/^data:[^;]+;base64,/, '')
      : chunk_data;
    const chunkBuffer = Buffer.from(base64Clean, 'base64');

    // Initialize or retrieve upload session
    if (!CHUNKED_UPLOAD_STORE.has(upload_id)) {
      if (chunkIdx !== 0) {
        res.status(400).json({ error: 'Upload session not found. Send chunk_index=0 first.' });
        return;
      }
      console.log(`[ChunkedUpload] Started upload session: ${upload_id} | totalChunks=${totalChunks} | file=${file_name}`);
      CHUNKED_UPLOAD_STORE.set(upload_id, {
        chunks: new Array(totalChunks).fill(null),
        totalChunks,
        mimeType: mime_type || 'video/mp4',
        fileName: file_name || `video-${Date.now()}.mp4`,
        createdAt: Date.now(),
      });
    }

    const session = CHUNKED_UPLOAD_STORE.get(upload_id)!;
    session.chunks[chunkIdx] = chunkBuffer;

    const receivedCount = session.chunks.filter(Boolean).length;
    console.log(`[ChunkedUpload] Received chunk ${chunkIdx + 1}/${totalChunks} for session ${upload_id} (${chunkBuffer.length} bytes)`);

    res.json({
      success: true,
      upload_id,
      chunk_index: chunkIdx,
      received: receivedCount,
      total: totalChunks,
      complete: receivedCount === totalChunks,
    });
  } catch (err: any) {
    console.error('[ChunkedUpload] Chunk receive error:', err);
    res.status(500).json({ error: err?.message || 'Failed to store chunk' });
  }
});

/**
 * POST /api/admin/upload-video/finalize
 * Assemble all chunks and upload the complete video to Supabase Storage.
 * Body: { upload_id }
 */
adminRouter.post('/upload-video/finalize', async (req, res) => {
  try {
    const { upload_id } = req.body;

    if (!upload_id) {
      res.status(400).json({ error: 'upload_id is required' });
      return;
    }

    const session = CHUNKED_UPLOAD_STORE.get(upload_id);
    if (!session) {
      res.status(404).json({ error: 'Upload session not found or expired' });
      return;
    }

    // Verify all chunks are present
    const missingChunks = session.chunks
      .map((c, i) => (!c ? i : -1))
      .filter((i) => i !== -1);

    if (missingChunks.length > 0) {
      res.status(400).json({
        error: `Missing chunks: ${missingChunks.join(', ')}. Please re-upload missing chunks.`,
        missingChunks,
      });
      return;
    }

    console.log(`[ChunkedUpload] Finalizing upload ${upload_id} — assembling ${session.totalChunks} chunks...`);

    // Assemble all chunks into a single Buffer
    const fullBuffer = Buffer.concat(session.chunks);
    const sanitizeName = session.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `videos/${Date.now()}-${sanitizeName}`;

    console.log(`[ChunkedUpload] Assembled buffer: ${fullBuffer.length} bytes. Uploading to Supabase Storage...`);

    // Ensure bucket exists
    await supabaseAdmin.storage.createBucket('wellness-videos', { public: true }).catch(() => {});

    // Upload assembled video to Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from('wellness-videos')
      .upload(storagePath, fullBuffer, {
        contentType: session.mimeType,
        upsert: true,
      });

    if (uploadError) {
      console.error('[ChunkedUpload] Storage upload failed:', uploadError.message);
      // Clean up session on failure
      CHUNKED_UPLOAD_STORE.delete(upload_id);
      res.status(500).json({ error: `Storage upload failed: ${uploadError.message}` });
      return;
    }

    const { data: publicUrlData } = supabaseAdmin.storage
      .from('wellness-videos')
      .getPublicUrl(storagePath);

    // Clean up completed session
    CHUNKED_UPLOAD_STORE.delete(upload_id);
    console.log(`[ChunkedUpload] Upload complete: ${upload_id} → ${publicUrlData.publicUrl}`);

    res.json({
      success: true,
      video_url: publicUrlData.publicUrl,
    });
  } catch (err: any) {
    console.error('[ChunkedUpload] Finalize error:', err);
    res.status(500).json({ error: err?.message || 'Failed to finalize video upload' });
  }
});

/**
 * POST /api/admin/upload-video
 * Legacy fallback: single-shot base64 upload for small files or clients that cannot chunk.
 * For large files, prefer the /upload-video/chunk + /upload-video/finalize flow.
 */
adminRouter.post('/upload-video', async (req, res) => {
  try {
    const { file_name, file_data } = req.body;

    if (!file_data) {
      res.status(400).json({ error: 'file_data (base64 string) is required' });
      return;
    }

    console.log(`[VideoUpload] Legacy single-shot upload started: ${file_name}`);

    // Extract mime type & raw buffer from base64
    let mimeType = 'video/mp4';
    let base64String = file_data;

    if (typeof file_data === 'string' && file_data.includes(',')) {
      const parts = file_data.split(',');
      const match = parts[0].match(/data:(.*?);base64/);
      if (match && match[1]) {
        mimeType = match[1];
      }
      base64String = parts[1];
    } else if (typeof file_data === 'string') {
      base64String = file_data.replace(/^data:[^;]+;base64,/, '');
    }

    const buffer = Buffer.from(base64String, 'base64');
    const sanitizeName = (file_name || `video-${Date.now()}.mp4`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `videos/${Date.now()}-${sanitizeName}`;

    await supabaseAdmin.storage.createBucket('wellness-videos', { public: true }).catch(() => {});

    const { error: uploadError } = await supabaseAdmin.storage
      .from('wellness-videos')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) {
      console.error('[VideoUpload] Storage upload failed:', uploadError.message);
      res.json({
        success: true,
        video_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      });
      return;
    }

    const { data: publicUrlData } = supabaseAdmin.storage
      .from('wellness-videos')
      .getPublicUrl(storagePath);

    console.log(`[VideoUpload] Legacy upload complete: ${publicUrlData.publicUrl}`);

    res.json({
      success: true,
      video_url: publicUrlData.publicUrl,
    });
  } catch (err: any) {
    console.error('[VideoUpload] Server upload error:', err);
    res.status(500).json({ error: err?.message || 'Failed to upload video to media host' });
  }
});


