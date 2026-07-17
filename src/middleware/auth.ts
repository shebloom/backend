import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../lib/supabase';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userRole?: 'patient' | 'doctor' | 'admin';
  userEmail?: string;
}

/**
 * Middleware that verifies the Supabase JWT from the Authorization header.
 * Attaches userId, userRole, and userEmail to the request object.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Fetch the user's role from our users table
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      // User exists in auth but not in users table — create a default patient record
      req.userId = user.id;
      req.userRole = 'patient';
      req.userEmail = user.email;
    } else {
      req.userId = user.id;
      req.userRole = profile.role as 'patient' | 'doctor' | 'admin';
      req.userEmail = user.email;
    }

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
}

/**
 * Middleware that requires a specific role (or array of roles).
 * Must be used after requireAuth.
 */
export function requireRole(...roles: Array<'patient' | 'doctor' | 'admin'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}
