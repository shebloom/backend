import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const membershipRouter = Router();

/**
 * GET /api/membership
 * Returns the current user's membership status.
 */
membershipRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  // Stripe integration placeholder — will be implemented when API keys are provided
  res.json({
    membership: {
      plan: 'bloom_monthly',
      status: 'active',
      current_period_end: null,
      consultations_remaining: 6,
      consultations_total: 6,
    },
    message: 'Stripe integration pending — using placeholder data',
  });
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
