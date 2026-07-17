import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const authRouter = Router();

/**
 * POST /api/auth/signup
 * Creates user in Supabase Auth + inserts a row in our users table.
 * The frontend calls Supabase Auth directly for the actual signup,
 * then calls this to ensure our users table is populated.
 */
authRouter.post('/sync-profile', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { full_name, phone, date_of_birth } = req.body;

    const { data, error } = await supabaseAdmin
      .from('users')
      .upsert(
        {
          id: req.userId,
          email: req.userEmail,
          full_name: full_name || null,
          phone: phone || null,
          date_of_birth: date_of_birth || null,
          role: 'patient',
        },
        { onConflict: 'id' }
      )
      .select()
      .single();

    if (error) {
      console.error('Profile sync error:', error);
      res.status(500).json({ error: 'Failed to sync profile' });
      return;
    }

    res.json({ user: data });
  } catch (err) {
    console.error('Profile sync error:', err);
    res.status(500).json({ error: 'Failed to sync profile' });
  }
});

/**
 * GET /api/auth/me
 * Returns the current user's profile from our users table.
 * Also includes doctor_application_status if an application exists.
 */
authRouter.get('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', req.userId)
      .single();

    if (error) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Check if user has a doctor application
    let doctor_application_status: string | null = null;
    const { data: application } = await supabaseAdmin
      .from('doctor_applications')
      .select('status')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (application) {
      doctor_application_status = application.status;
    }

    res.json({ user: { ...data, doctor_application_status } });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

/**
 * PATCH /api/auth/me
 * Updates the current user's profile.
 */
authRouter.patch('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const allowedFields = ['full_name', 'phone', 'date_of_birth', 'avatar_url', 'weight_kg', 'height_cm', 'blood_group'];
    const updates: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', req.userId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update profile' });
      return;
    }

    res.json({ user: data });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * DELETE /api/auth/me
 * Permanently delete the user account and cascade cleanup all data.
 */
authRouter.delete('/me', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.userId!;

    // 1. Fetch conversations where user is a participant to delete associated messages
    const { data: convos } = await supabaseAdmin
      .from('chat_conversations')
      .select('id')
      .or(`patient_id.eq.${userId},doctor_id.eq.${userId}`);

    if (convos && convos.length > 0) {
      const convoIds = convos.map((c) => c.id);
      await supabaseAdmin.from('chat_messages').delete().in('conversation_id', convoIds);
      await supabaseAdmin.from('chat_conversations').delete().or(`patient_id.eq.${userId},doctor_id.eq.${userId}`);
    }

    // 2. Delete all standard user-linked records
    await supabaseAdmin.from('health_records').delete().eq('user_id', userId);
    await supabaseAdmin.from('symptoms').delete().eq('user_id', userId);
    await supabaseAdmin.from('cycle_logs').delete().eq('user_id', userId);
    
    // 3. Delete doctor-specific records
    await supabaseAdmin.from('doctors').delete().eq('user_id', userId);
    
    // Unlink admin references just in case (prevent constraint errors if they were an admin)
    await supabaseAdmin.from('doctor_applications').update({ reviewed_by: null }).eq('reviewed_by', userId);
    await supabaseAdmin.from('admin_audit_log').update({ admin_id: null }).eq('admin_id', userId);

    await supabaseAdmin.from('doctor_applications').delete().eq('user_id', userId);

    // 4. Delete the user from public.users
    await supabaseAdmin.from('users').delete().eq('id', userId);

    // 5. Delete the user from Supabase Auth
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authError) {
      console.error('Failed to delete auth user:', authError);
      // Even if auth delete fails slightly, we've deleted their public data.
    }

    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});
