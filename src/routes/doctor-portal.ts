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

    const now = new Date();
    const todayStr = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    let appointments = data || [];
    if (upcoming === 'true') {
      appointments = appointments.filter((a: any) => {
        if (a.appointment_date === todayStr) {
          const [h, m] = a.slot_time.split(':').map(Number);
          const slotMinutes = h * 60 + (m || 0);
          return slotMinutes > nowMinutes;
        }
        return true;
      });
    }

    res.json({ appointments });
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
 * DELETE /api/doctor-portal/slots
 * Safely delete a slot. Protects booked slots from silent deletion!
 */
doctorPortalRouter.delete('/slots', async (req: AuthenticatedRequest, res) => {
  try {
    const { date, slot_time, day_of_week } = req.body;

    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor record not found' });
      return;
    }

    if (date && slot_time) {
      // Check if there is an active booking on this date and time
      const { data: booking } = await supabaseAdmin
        .from('appointments')
        .select('id, patient_id, appointment_date, slot_time, status, users!appointments_patient_id_fkey(full_name)')
        .eq('doctor_id', doctor.id)
        .eq('appointment_date', date)
        .eq('slot_time', slot_time)
        .in('status', ['confirmed', 'pending'])
        .maybeSingle();

      if (booking) {
        const patientUser: any = (booking as any).users;
        const patientName = Array.isArray(patientUser) ? patientUser[0]?.full_name : patientUser?.full_name;
        res.status(409).json({
          error: `This slot is booked by ${patientName || 'a patient'}. Silently deleting booked slots is disabled. Please cancel or reschedule the appointment to notify the patient.`,
          isBooked: true,
          booking: {
            id: booking.id,
            patient_name: patientName,
            appointment_date: booking.appointment_date,
            slot_time: booking.slot_time,
          },
        });
        return;
      }
    }

    // Delete availability slot if unbooked
    if (day_of_week !== undefined && slot_time) {
      await supabaseAdmin
        .from('doctor_availability')
        .delete()
        .eq('doctor_id', doctor.id)
        .eq('day_of_week', day_of_week)
        .eq('start_time', slot_time);
    }

    res.json({ success: true, message: 'Slot removed' });
  } catch (err) {
    console.error('Delete slot error:', err);
    res.status(500).json({ error: 'Failed to delete slot' });
  }
});

/**
 * POST /api/doctor-portal/appointments/:id/cancel-with-notification
 * Explicitly cancel or reschedule a booked slot and notify the patient.
 */
doctorPortalRouter.post('/appointments/:id/cancel-with-notification', async (req: AuthenticatedRequest, res) => {
  try {
    const { action, reason } = req.body; // action: 'cancel' | 'reschedule'

    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id, user_id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }

    const { data: appointment } = await supabaseAdmin
      .from('appointments')
      .select('*, users!appointments_patient_id_fkey(full_name, email)')
      .eq('id', req.params.id)
      .single();

    if (!appointment) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const newStatus = action === 'reschedule' ? 'rescheduled' : 'cancelled';

    // Update appointment status
    await supabaseAdmin
      .from('appointments')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);

    // Notify patient via chat system message
    const patientId = appointment.patient_id;
    const { data: convo } = await supabaseAdmin
      .from('chat_conversations')
      .select('id')
      .eq('patient_id', patientId)
      .eq('doctor_id', doctor.user_id)
      .maybeSingle();

    let convoId = convo?.id;
    if (!convoId) {
      const { data: newConvo } = await supabaseAdmin
        .from('chat_conversations')
        .insert({ patient_id: patientId, doctor_id: doctor.user_id })
        .select('id')
        .single();
      convoId = newConvo?.id;
    }

    if (convoId) {
      const notificationText = action === 'reschedule'
        ? `⚠️ Notice from Dr. Deepa Madhavan: Your consultation scheduled for ${appointment.appointment_date} at ${appointment.slot_time} needs to be rescheduled. Reason: ${reason || 'Schedule update'}. Please pick a new slot at your earliest convenience.`
        : `❌ Notice from Dr. Deepa Madhavan: Your consultation scheduled for ${appointment.appointment_date} at ${appointment.slot_time} has been cancelled. Reason: ${reason || 'Doctor unavailable'}.`;

      await supabaseAdmin.from('chat_messages').insert({
        conversation_id: convoId,
        sender_id: doctor.user_id,
        content: notificationText,
      });
    }

    res.json({ success: true, message: `Appointment ${newStatus} and patient notified.` });
  } catch (err) {
    console.error('Cancel with notification error:', err);
    res.status(500).json({ error: 'Failed to process cancellation' });
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

/**
 * GET /api/doctor-portal/availability
 * Returns the doctor's recurring weekly availability.
 */
doctorPortalRouter.get('/availability', async (req: AuthenticatedRequest, res) => {
  try {
    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor record not found' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('doctor_availability')
      .select('*')
      .eq('doctor_id', doctor.id)
      .order('day_of_week', { ascending: true })
      .order('start_time', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch availability' });
      return;
    }

    res.json({ slots: data || [] });
  } catch (err) {
    console.error('Get availability error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/doctor-portal/analytics
 * Returns completed consultations, unique patients count, and chart data matching time-range filter.
 */
doctorPortalRouter.get('/analytics', async (req: AuthenticatedRequest, res) => {
  try {
    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor record not found' });
      return;
    }

    const range = req.query.range as string || 'month';
    let days = 30;
    if (range === 'week') days = 7;
    else if (range === '2 weeks') days = 14;
    else if (range === 'month') days = 30;
    else if (range === '4 months') days = 120;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];

    // Fetch all completed appointments for this doctor
    const { data: appts, error: apptsError } = await supabaseAdmin
      .from('appointments')
      .select('patient_id, appointment_date')
      .eq('doctor_id', doctor.id)
      .eq('status', 'completed');

    if (apptsError) {
      res.status(500).json({ error: 'Failed to fetch appointments' });
      return;
    }

    // Filter appointments in time range
    const filteredAppts = (appts || []).filter(a => a.appointment_date >= startDateStr);
    const totalCompleted = filteredAppts.length;
    const uniquePatients = new Set(filteredAppts.map(a => a.patient_id)).size;

    // Group appointments by date
    const apptsByDate: Record<string, typeof appts> = {};
    for (const appt of filteredAppts) {
      const dateStr = appt.appointment_date;
      if (!apptsByDate[dateStr]) apptsByDate[dateStr] = [];
      apptsByDate[dateStr].push(appt);
    }

    // Generate chart data points
    const chartData = [];
    const tempDate = new Date(startDate);
    const step = days > 30 ? 7 : 1; // if 4 months, group by week; otherwise daily
    const totalSteps = Math.ceil(days / step);

    for (let i = 0; i < totalSteps; i++) {
      const labelStr = tempDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const stepAppts: any[] = [];
      
      for (let s = 0; s < step; s++) {
        const dateStr = tempDate.toISOString().split('T')[0];
        if (apptsByDate[dateStr]) {
          stepAppts.push(...apptsByDate[dateStr]);
        }
        tempDate.setDate(tempDate.getDate() + 1);
      }

      chartData.push({
        label: labelStr,
        consultations: stepAppts.length,
        patients: new Set(stepAppts.map(a => a.patient_id)).size
      });
    }

    // Also get grand totals
    const { count: grandCompleted } = await supabaseAdmin
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('doctor_id', doctor.id)
      .eq('status', 'completed');

    res.json({
      total_completed_all_time: grandCompleted || 0,
      total_completed_in_range: totalCompleted,
      unique_patients_in_range: uniquePatients,
      chart_data: chartData
    });
  } catch (err) {
    console.error('Get doctor analytics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/doctor-portal/patients/:patientId
 * Returns profile details for a specific patient.
 */
doctorPortalRouter.get('/patients/:patientId', async (req: AuthenticatedRequest, res) => {
  try {
    const { data: patient, error } = await supabaseAdmin
      .from('users')
      .select('id, full_name, email, phone, date_of_birth, weight_kg, height_cm, blood_group, avatar_url')
      .eq('id', req.params.patientId)
      .single();

    if (error || !patient) {
      res.status(404).json({ error: 'Patient not found' });
      return;
    }

    res.json({ patient });
  } catch (err) {
    console.error('Get doctor patient profile error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/doctor-portal/patients/:patientId/health-records
 * Returns list of health records for a patient.
 */
doctorPortalRouter.get('/patients/:patientId/health-records', async (req: AuthenticatedRequest, res) => {
  try {
    const { data: records, error } = await supabaseAdmin
      .from('health_records')
      .select('*')
      .eq('user_id', req.params.patientId)
      .order('record_date', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch health records' });
      return;
    }

    res.json({ records: records || [] });
  } catch (err) {
    console.error('Get doctor patient health records error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/doctor-portal/patients/:patientId/documents/:filename
 * Streams/downloads patient documents securely.
 */
doctorPortalRouter.get('/patients/:patientId/documents/:filename', async (req: AuthenticatedRequest, res) => {
  try {
    const patientId = req.params.patientId as string;
    const filename = req.params.filename as string;

    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }

    // Verify there is a booking between doctor and patient to authorize access
    const { data: booking } = await supabaseAdmin
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctor.id)
      .eq('patient_id', patientId)
      .limit(1)
      .maybeSingle();

    if (!booking) {
      res.status(403).json({ error: 'Unauthorized to view this patient\'s records' });
      return;
    }

    const { data, error } = await supabaseAdmin.storage
      .from('health-records')
      .download(`${patientId}/${filename}`);

    if (error || !data) {
      console.error('Patient document download error:', error);
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
    console.error('Doctor stream patient document error:', err);
    res.status(500).json({ error: 'Failed to retrieve document' });
  }
});

/**
 * PATCH /api/doctor-portal/appointments/:id
 * Allows a doctor to reschedule an appointment.
 */
doctorPortalRouter.patch('/appointments/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { appointment_date, slot_time, status } = req.body;

    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (!doctor) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }

    const updates: any = {};
    if (appointment_date) updates.appointment_date = appointment_date;
    if (slot_time) updates.slot_time = slot_time;
    if (status) updates.status = status;

    const { data, error } = await supabaseAdmin
      .from('appointments')
      .update(updates)
      .eq('id', req.params.id)
      .eq('doctor_id', doctor.id)
      .select('*, users!appointments_patient_id_fkey(full_name, email)')
      .single();

    if (error) {
      console.error('Doctor reschedule db error:', error);
      res.status(500).json({ error: 'Failed to update appointment' });
      return;
    }

    res.json({ appointment: data });
  } catch (err) {
    console.error('Doctor reschedule error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});
