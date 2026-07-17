import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const authRouter = Router();

/**
 * POST /api/auth/register
 * Server-side signup using Admin API so we can auto-confirm the email.
 * This avoids the "email not confirmed" problem entirely.
 */
authRouter.post('/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // Create the user via Admin API with email_confirm: true
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // <-- This auto-confirms; no verification email needed
      user_metadata: { full_name: full_name || null },
    });

    if (authError) {
      console.error('Admin createUser error:', authError);
      // Map common errors to friendly messages
      const msg = authError.message || '';
      if (msg.includes('already been registered') || msg.includes('already exists')) {
        res.status(409).json({ error: 'An account with this email already exists. Try logging in instead!' });
        return;
      }
      res.status(400).json({ error: msg || 'Failed to create account' });
      return;
    }

    // Insert into our users table
    const userId = authData.user.id;
    await supabaseAdmin
      .from('users')
      .upsert(
        {
          id: userId,
          email,
          full_name: full_name || null,
          role: 'patient',
        },
        { onConflict: 'id' }
      );

    res.json({ success: true, message: 'Account created successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

/**
 * POST /api/auth/google
 * Pure Google OAuth — no Supabase OAuth provider needed.
 * Receives a Google authorization code from the frontend popup,
 * exchanges it for an ID token, verifies identity, and returns
 * a magic-link token that the frontend uses to create a Supabase session.
 */
authRouter.post('/google', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      res.status(400).json({ error: 'Authorization code is required' });
      return;
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!googleClientId || !googleClientSecret) {
      console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET env variables');
      res.status(500).json({ error: 'Google OAuth is not configured on the server' });
      return;
    }

    // Step 1: Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: 'postmessage', // Special value for popup-based flow
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.id_token) {
      console.error('Google token exchange failed:', tokens);
      res.status(400).json({ error: 'Failed to authenticate with Google' });
      return;
    }

    // Step 2: Decode ID token to get user info
    // (Safe to decode without signature verification since we received it
    //  directly from Google's servers over HTTPS in the step above)
    const payload = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8')
    );

    const email = payload.email as string;
    const name = (payload.name || payload.given_name || '') as string;
    const picture = (payload.picture || '') as string;

    if (!email) {
      res.status(400).json({ error: 'Email not found in Google account' });
      return;
    }

    // Step 3: Find or create user in Supabase Auth + our users table
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (!existingUser) {
      // New user — create in Supabase Auth
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: name, avatar_url: picture },
      });

      if (authError && !authError.message?.includes('already')) {
        console.error('Create Google user error:', authError);
        res.status(500).json({ error: 'Failed to create account' });
        return;
      }

      // Create in users table
      if (authData?.user) {
        await supabaseAdmin.from('users').upsert(
          {
            id: authData.user.id,
            email,
            full_name: name,
            avatar_url: picture,
            role: 'patient',
          },
          { onConflict: 'id' }
        );
      }
    }

    // Step 4: Generate a magic-link token for this email
    // This creates a one-time token the frontend can use with verifyOtp()
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
    });

    if (linkError || !linkData) {
      console.error('Generate magic link error:', linkError);
      res.status(500).json({ error: 'Failed to create session' });
      return;
    }

    res.json({
      token_hash: linkData.properties.hashed_token,
    });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

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
    let { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', req.userId)
      .single();

    // If user doesn't exist in our DB yet (e.g. first Google OAuth login),
    // auto-provision them so login works seamlessly.
    if (error || !data) {
      // Fetch their name from Supabase Auth metadata
      const { data: { user: authUser } } = await supabaseAdmin.auth.admin.getUserById(req.userId!);
      const fullName = authUser?.user_metadata?.full_name || authUser?.user_metadata?.name || null;

      const { data: newUser, error: createError } = await supabaseAdmin
        .from('users')
        .upsert(
          {
            id: req.userId,
            email: req.userEmail,
            full_name: fullName,
            role: 'patient',
          },
          { onConflict: 'id' }
        )
        .select()
        .single();

      if (createError || !newUser) {
        console.error('Auto-provision user error:', createError);
        res.status(404).json({ error: 'User not found' });
        return;
      }

      data = newUser;
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
