import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth';

export const doctorPortalRouter = Router();

// All doctor portal routes require doctor role
doctorPortalRouter.use(requireAuth);
doctorPortalRouter.use(requireRole('doctor'));

/**
 * GET /api/doctor-portal/profile
 * Returns the doctor's own profile.
 */
doctorPortalRouter.get('/profile', async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('doctors')
      .select('*, users!inner(full_name, avatar_url, email)')
      .eq('user_id', req.userId)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Doctor profile not found' });
      return;
    }

    res.json({ doctor: data });
  } catch (err) {
    console.error('Get doctor profile error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * PATCH /api/doctor-portal/profile
 * Updates the doctor's profile details.
 */
doctorPortalRouter.patch('/profile', async (req: AuthenticatedRequest, res) => {
  try {
    const {
      about,
      consultation_fee,
      consultation_type,
      current_workplace,
      previous_workplace,
      degrees,
      universities,
      specialties,
    } = req.body;

    const updates: any = {};
    if (about !== undefined) updates.about = about;
    if (consultation_fee !== undefined) updates.consultation_fee = consultation_fee;
    if (consultation_type !== undefined) updates.consultation_type = consultation_type;
    if (current_workplace !== undefined) updates.current_workplace = current_workplace;
    if (previous_workplace !== undefined) updates.previous_workplace = previous_workplace;
    if (degrees !== undefined) updates.degrees = degrees;
    if (universities !== undefined) updates.universities = universities;
    if (specialties !== undefined) updates.specialties = specialties;

    // Nothing to update
    if (Object.keys(updates).length === 0) {
      // Just return current profile
      const { data: current } = await supabaseAdmin
        .from('doctors')
        .select('*, users!inner(full_name, avatar_url, email)')
        .eq('user_id', req.userId)
        .single();
      res.json({ doctor: current });
      return;
    }

    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('doctors')
      .update(updates)
      .eq('user_id', req.userId)
      .select('*, users!inner(full_name, avatar_url, email)')
      .single();

    if (error) {
      console.error('Doctor profile update DB error:', JSON.stringify(error));
      res.status(500).json({ error: 'Failed to update doctor profile' });
      return;
    }

    res.json({ doctor: data });
  } catch (err) {
    console.error('Update doctor profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

/**
 * GET /api/doctor-portal/appointments
 * Returns the doctor's appointments.
 */
doctorPortalRouter.get('/appointments', async (req: AuthenticatedRequest, res) => {
  try {
    const { status, upcoming } = req.query;

    // First get the doctor record
    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor record not found' });
      return;
    }

    let query = supabaseAdmin
      .from('appointments')
      .select('*, users!appointments_patient_id_fkey(full_name, avatar_url)')
      .eq('doctor_id', doctor.id);

    if (status) query = query.eq('status', status);

    if (upcoming === 'true') {
      query = query
        .gte('appointment_date', new Date().toISOString().split('T')[0])
        .in('status', ['confirmed', 'pending'])
        .order('appointment_date', { ascending: true });
    } else {
      query = query.order('appointment_date', { ascending: false });
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: 'Failed to fetch appointments' });
      return;
    }

    res.json({ appointments: data || [] });
  } catch (err) {
    console.error('Get doctor appointments error:', err);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

/**
 * PUT /api/doctor-portal/availability
 * Update the doctor's weekly availability schedule.
 * Expects an array of { day_of_week, start_time, end_time }.
 */
doctorPortalRouter.put('/availability', async (req: AuthenticatedRequest, res) => {
  try {
    const { slots } = req.body;

    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor record not found' });
      return;
    }

    // Clear existing availability and insert new
    await supabaseAdmin
      .from('doctor_availability')
      .delete()
      .eq('doctor_id', doctor.id);

    if (slots && slots.length > 0) {
      const rows = slots.map((s: any) => ({
        doctor_id: doctor.id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }));

      const { error } = await supabaseAdmin
        .from('doctor_availability')
        .insert(rows);

      if (error) {
        res.status(500).json({ error: 'Failed to update availability' });
        return;
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update availability error:', err);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

/**
 * GET /api/doctor-portal/stats
 * Returns earnings summary and ratings.
 */
doctorPortalRouter.get('/stats', async (req: AuthenticatedRequest, res) => {
  try {
    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id, rating, review_count')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor record not found' });
      return;
    }

    const { count: totalAppointments } = await supabaseAdmin
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('doctor_id', doctor.id)
      .eq('status', 'completed');

    const { count: upcomingCount } = await supabaseAdmin
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('doctor_id', doctor.id)
      .gte('appointment_date', new Date().toISOString().split('T')[0])
      .in('status', ['confirmed', 'pending']);

    res.json({
      rating: doctor.rating,
      review_count: doctor.review_count,
      total_completed: totalAppointments || 0,
      upcoming: upcomingCount || 0,
    });
  } catch (err) {
    console.error('Get doctor stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});
