import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const appointmentsRouter = Router();

/**
 * POST /api/appointments
 * Book a new appointment.
 */
appointmentsRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { doctor_id, appointment_date, slot_time, consultation_type, notes } = req.body;

    if (!doctor_id || !appointment_date || !slot_time) {
      res.status(400).json({ error: 'doctor_id, appointment_date, and slot_time are required' });
      return;
    }

    // Check if slot is still available
    const { data: existing } = await supabaseAdmin
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctor_id)
      .eq('appointment_date', appointment_date)
      .eq('slot_time', slot_time)
      .in('status', ['confirmed', 'pending'])
      .single();

    if (existing) {
      res.status(409).json({ error: 'This slot is no longer available' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('appointments')
      .insert({
        patient_id: req.userId,
        doctor_id,
        appointment_date,
        slot_time,
        consultation_type: consultation_type || 'video',
        notes: notes || null,
        status: 'confirmed',
      })
      .select('*, doctors(*, users!inner(full_name, avatar_url))')
      .single();

    if (error) {
      console.error('Booking error:', error);
      res.status(500).json({ error: 'Failed to book appointment' });
      return;
    }

    res.status(201).json({ appointment: data });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Failed to book appointment' });
  }
});

/**
 * GET /api/appointments
 * Returns the current user's appointments.
 */
appointmentsRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { status, upcoming } = req.query;

    let query = supabaseAdmin
      .from('appointments')
      .select('*, doctors(*, users!inner(full_name, avatar_url))')
      .eq('patient_id', req.userId);

    if (status) {
      query = query.eq('status', status);
    }

    if (upcoming === 'true') {
      query = query
        .gte('appointment_date', new Date().toISOString().split('T')[0])
        .in('status', ['confirmed', 'pending'])
        .order('appointment_date', { ascending: true })
        .order('slot_time', { ascending: true })
        .limit(5);
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
    console.error('Get appointments error:', err);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

/**
 * PATCH /api/appointments/:id
 * Update appointment status (cancel, reschedule).
 */
appointmentsRouter.patch('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { status, appointment_date, slot_time } = req.body;

    const updates: Record<string, unknown> = {};
    if (status) updates.status = status;
    if (appointment_date) updates.appointment_date = appointment_date;
    if (slot_time) updates.slot_time = slot_time;

    const { data, error } = await supabaseAdmin
      .from('appointments')
      .update(updates)
      .eq('id', req.params.id)
      .eq('patient_id', req.userId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update appointment' });
      return;
    }

    res.json({ appointment: data });
  } catch (err) {
    console.error('Update appointment error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});
