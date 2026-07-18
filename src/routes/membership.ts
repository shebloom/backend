import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { supabaseAdmin } from '../lib/supabase';

export const membershipRouter = Router();

/**
 * GET /api/membership
 * Returns the current user's membership status.
 */
membershipRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    // Try to get membership from database
    const { data: dbMembership, error } = await supabaseAdmin
      .from('memberships')
      .select('*')
      .eq('user_id', req.userId)
      .maybeSingle();

    if (dbMembership) {
      res.json({
        membership: {
          plan: dbMembership.plan_id,
          status: dbMembership.status,
          current_period_end: dbMembership.current_period_end,
          consultations_remaining: dbMembership.consultations_remaining,
          consultations_total: dbMembership.consultations_total,
        }
      });
      return;
    }

    // Provision a new free tier membership
    // Get user's created_at date
    const { data: userProfile } = await supabaseAdmin
      .from('users')
      .select('created_at')
      .eq('id', req.userId)
      .single();

    const signupDate = userProfile?.created_at ? new Date(userProfile.created_at) : new Date();
    // Expiry is 30 days after signup
    const expiryDate = new Date(signupDate);
    expiryDate.setDate(expiryDate.getDate() + 30);

    const newMemb = {
      user_id: req.userId,
      plan_id: 'free_tier',
      status: 'active',
      current_period_end: expiryDate.toISOString(),
      consultations_total: 3,
      consultations_remaining: 3,
    };

    const { data: createdMemb, error: insertError } = await supabaseAdmin
      .from('memberships')
      .insert(newMemb)
      .select()
      .single();

    if (insertError) {
      console.error('Failed to create membership in DB:', insertError);
      // Fallback response so app doesn't break
      res.json({
        membership: {
          plan: 'free_tier',
          status: 'active',
          current_period_end: expiryDate.toISOString(),
          consultations_remaining: 3,
          consultations_total: 3,
        }
      });
      return;
    }

    res.json({
      membership: {
        plan: createdMemb.plan_id,
        status: createdMemb.status,
        current_period_end: createdMemb.current_period_end,
        consultations_remaining: createdMemb.consultations_remaining,
        consultations_total: createdMemb.consultations_total,
      }
    });
  } catch (err) {
    console.error('Membership load error:', err);
    res.status(500).json({ error: 'Failed to retrieve membership details' });
  }
});

/**
 * POST /api/membership/checkout
 * Creates a Stripe Checkout session.
 */
membershipRouter.post('/checkout', requireAuth, async (req: AuthenticatedRequest, res) => {
  res.status(501).json({
    error: 'Stripe integration not yet configured. Provide STRIPE_SECRET_KEY to enable.',
  });
});

/**
 * POST /api/membership/webhook
 * Stripe webhook endpoint.
 */
membershipRouter.post('/webhook', (_req, res) => {
  res.status(501).json({
    error: 'Stripe webhook not yet configured.',
  });
});
