import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { memoryCache } from '../lib/cache';

export const appointmentsRouter = Router();

/**
 * Helper to generate video room via Daily.co API or verified clean Jitsi Meet WebRTC fallback
 */
async function createVideoRoom(appointmentId: string): Promise<string> {
  const dailyApiKey = process.env.DAILY_API_KEY;
  if (dailyApiKey) {
    try {
      const response = await fetch('https://api.daily.co/v1/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${dailyApiKey}`,
        },
        body: JSON.stringify({
          name: `shebloomconsult${appointmentId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 12)}`,
          privacy: 'public',
          properties: {
            enable_chat: true,
            start_video_off: false,
            start_audio_off: false,
            exp: Math.floor(Date.now() / 1000) + 86400,
          },
        }),
      });
      const data = (await response.json()) as any;
      if (data?.url) return data.url;
    } catch (err) {
      console.error('Daily.co API room creation error:', err);
    }
  }

  // Verified WebRTC room fallback (Jitsi Meet) requiring 0 API key setup with clean room name
  const cleanHash = appointmentId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
  return `https://meet.jit.si/SheBloomConsult${cleanHash}`;
}

/**
 * POST /api/appointments
 * Book a new appointment under the 12 free consultations/year rule. Video-only.
 */
appointmentsRouter.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { doctor_id, appointment_date, slot_time, notes } = req.body;

    if (!doctor_id || !appointment_date || !slot_time) {
      res.status(400).json({ error: 'doctor_id, appointment_date, and slot_time are required' });
      return;
    }

    // 1. Enforce 12 consultations per patient per year rule (365 days rolling window)
    const oneYearAgo = new Date();
    oneYearAgo.setDate(oneYearAgo.getDate() - 365);
    const oneYearAgoStr = oneYearAgo.toISOString().split('T')[0];

    const { data: pastYearAppts, error: apptErr } = await supabaseAdmin
      .from('appointments')
      .select('id, appointment_date')
      .eq('patient_id', req.userId)
      .gte('appointment_date', oneYearAgoStr)
      .in('status', ['confirmed', 'completed', 'pending'])
      .order('appointment_date', { ascending: true });

    if (apptErr) {
      console.error('Failed to query past year appointments:', apptErr);
    }

    const apptCount = pastYearAppts ? pastYearAppts.length : 0;

    if (apptCount >= 12) {
      // Calculate reset date (1 year after oldest appointment in window)
      const oldestApptDate = (pastYearAppts && pastYearAppts.length > 0) ? pastYearAppts[0].appointment_date : oneYearAgoStr;
      const resetDateObj = new Date(oldestApptDate);
      resetDateObj.setDate(resetDateObj.getDate() + 365);
      const resetDateFormatted = resetDateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

      res.status(403).json({
        error: `You've completed your 12 free consultations for this year. Please wait until ${resetDateFormatted} or upgrade for additional consultations.`,
        limitReached: true,
        resetDate: resetDateFormatted,
      });
      return;
    }

    // 2. Check if slot is still available
    const { data: existing } = await supabaseAdmin
      .from('appointments')
      .select('id')
      .eq('doctor_id', doctor_id)
      .eq('appointment_date', appointment_date)
      .eq('slot_time', slot_time)
      .in('status', ['confirmed', 'pending'])
      .maybeSingle();

    if (existing) {
      res.status(409).json({ error: 'This slot is no longer available' });
      return;
    }

    // 3. Create appointment with video_room_url (Strictly Video-Only)
    const tempId = `appt-${Date.now()}`;
    const videoRoomUrl = await createVideoRoom(tempId);

    let data: any = null;

    // Try inserting with video_room_url first
    const { data: fullData, error: fullError } = await supabaseAdmin
      .from('appointments')
      .insert({
        patient_id: req.userId,
        doctor_id,
        appointment_date,
        slot_time,
        consultation_type: 'video',
        video_room_url: videoRoomUrl,
        notes: notes || null,
        status: 'confirmed',
      })
      .select('*, doctors(*, users!inner(full_name, avatar_url))')
      .single();

    if (fullError) {
      // Fallback: insert without video_room_url if column doesn't exist
      console.warn('Appointments insert with video_room_url failed, retrying without:', fullError.message);
      const { data: fallbackData, error: fallbackError } = await supabaseAdmin
        .from('appointments')
        .insert({
          patient_id: req.userId,
          doctor_id,
          appointment_date,
          slot_time,
          consultation_type: 'video',
          notes: notes || null,
          status: 'confirmed',
        })
        .select('*, doctors(*, users!inner(full_name, avatar_url))')
        .single();

      if (fallbackError) {
        console.error('Booking error (fallback):', fallbackError);
        res.status(500).json({ error: 'Failed to book appointment' });
        return;
      }
      data = fallbackData;
    } else {
      data = fullData;
    }

    // Invalidate slot cache on write
    memoryCache.del('slots:');

    // Update membership status
    await supabaseAdmin
      .from('memberships')
      .upsert({
        user_id: req.userId,
        plan_id: 'free_tier_12_annual',
        status: 'active',
        consultations_total: 12,
        consultations_remaining: Math.max(0, 12 - (apptCount + 1)),
      }, { onConflict: 'user_id' });

    res.status(201).json({
      appointment: {
        ...data,
        video_room_url: videoRoomUrl,
      },
      consultations_used: apptCount + 1,
      consultations_total: 12,
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Failed to book appointment' });
  }
});

/**
 * GET /api/appointments
 * Returns the current user's appointments with video room links.
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

    const now = new Date();

    // Process appointments with 10-minute grace period enforcement
    let formatted = (data || []).map((a: any) => {
      const [y, m, d] = (a.appointment_date || '').split('-').map(Number);
      const [h, min] = (a.slot_time || '').split(':').map(Number);
      const scheduledDateTime = new Date(y, (m || 1) - 1, d || 1, h || 0, min || 0, 0, 0);
      const graceEnd = new Date(scheduledDateTime.getTime() + 10 * 60 * 1000); // 10-minute grace period

      const isTooEarly = now < scheduledDateTime;
      const isJoinableWindow = now >= scheduledDateTime && now <= graceEnd;
      const isPastGrace = now > graceEnd;

      let displayStatus = a.status;
      if (isPastGrace && ['confirmed', 'pending', 'rescheduled'].includes(a.status)) {
        displayStatus = 'missed';
        supabaseAdmin.from('appointments').update({ status: 'missed' }).eq('id', a.id).then();
      }

      return {
        ...a,
        status: displayStatus,
        consultation_type: 'video',
        video_room_url: a.video_room_url || `https://shebloom.daily.co/consult-${a.id?.substring(0, 8) || 'room'}`,
        display_status: displayStatus,
        is_too_early: isTooEarly,
        is_joinable: isJoinableWindow,
        is_past_grace: isPastGrace,
        grace_seconds_remaining: isJoinableWindow ? Math.max(0, Math.floor((graceEnd.getTime() - now.getTime()) / 1000)) : 0,
        can_reschedule: isPastGrace || ['missed', 'canceled'].includes(displayStatus),
      };
    });

    if (upcoming === 'true') {
      formatted = formatted.filter((a: any) => {
        return (a.is_joinable || a.is_too_early) && ['confirmed', 'pending', 'rescheduled'].includes(a.display_status);
      });
    }

    res.json({ appointments: formatted });
  } catch (err) {
    console.error('Get appointments error:', err);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
});

/**
 * GET /api/appointments/:id/join
 * Join the video call for an appointment. Checks scheduled time and returns room details/token.
 */
appointmentsRouter.get('/:id/join', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const appointmentId = req.params.id;

    // Fetch the appointment along with doctor and patient information
    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from('appointments')
      .select('*, doctors(*, users!inner(full_name)), users!appointments_patient_id_fkey(full_name)')
      .eq('id', appointmentId)
      .single();

    if (apptErr || !appointment) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    // Verify authorized party: patient or doctor of the appointment
    const isPatient = req.userId === appointment.patient_id;
    const isDoctor = req.userId === appointment.doctors?.user_id;

    if (!isPatient && !isDoctor) {
      res.status(403).json({ error: 'You are not authorized to join this call' });
      return;
    }

    // 10-Minute Grace Window Validation
    const apptDateStr = appointment.appointment_date; // YYYY-MM-DD
    const [y, m, d] = apptDateStr.split('-').map(Number);
    const [sh, sm] = appointment.slot_time.split(':').map(Number);

    const now = new Date();
    const scheduledStart = new Date(y, (m || 1) - 1, d || 1, sh || 0, sm || 0, 0, 0);
    const graceEnd = new Date(scheduledStart.getTime() + 10 * 60 * 1000); // 10-minute grace window

    // Condition A: Before scheduled start time
    if (now < scheduledStart) {
      const diffMs = scheduledStart.getTime() - now.getTime();
      const diffSecs = Math.max(0, Math.floor(diffMs / 1000));
      res.status(403).json({
        error: `This consultation is scheduled to start at ${appointment.slot_time} on ${apptDateStr}. Access is gated until the scheduled time.`,
        joinable: false,
        reason: 'too_early',
        scheduledTime: scheduledStart.toISOString(),
        secondsRemaining: diffSecs,
      });
      return;
    }

    // Condition B: After 10-minute grace window has passed
    if (now > graceEnd) {
      // Auto-update appointment status in DB to 'missed' if still active
      if (['confirmed', 'pending', 'rescheduled'].includes(appointment.status)) {
        await supabaseAdmin
          .from('appointments')
          .update({ status: 'missed' })
          .eq('id', appointmentId);
      }

      res.status(403).json({
        error: 'The 10-minute join window for this consultation has expired. Please reschedule your appointment.',
        joinable: false,
        reason: 'expired',
        status: 'missed',
        canReschedule: true,
      });
      return;
    }

    // Condition C: Within active 10-minute grace window
    const secondsRemainingInGraceWindow = Math.max(0, Math.floor((graceEnd.getTime() - now.getTime()) / 1000));

    const cleanHash = appointment.id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
    let roomBaseUrl = appointment.video_room_url;

    if (!roomBaseUrl || roomBaseUrl.includes('shebloom.daily.co') || roomBaseUrl.includes('#config')) {
      roomBaseUrl = `https://meet.jit.si/SheBloomConsult${cleanHash}`;
      supabaseAdmin.from('appointments').update({ video_room_url: roomBaseUrl }).eq('id', appointmentId).then();
    }
    const dailyApiKey = process.env.DAILY_API_KEY;

    let joinUrl = roomBaseUrl;
    let useSimulation = false;

    if (dailyApiKey) {
      try {
        const userName = isDoctor
          ? (appointment.doctors?.users?.full_name || 'Dr. Deeba')
          : (appointment.users?.full_name || 'Patient');
        const roomName = `shebloom-consult-${appointment.id.substring(0, 8)}`;

        const tokenResponse = await fetch('https://api.daily.co/v1/meeting_tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${dailyApiKey.trim()}`,
          },
          body: JSON.stringify({
            properties: {
              room_name: roomName,
              is_owner: isDoctor,
              user_name: userName,
              exp: Math.floor(Date.now() / 1000) + 7200, // Token expires in 2 hours
            },
          }),
        });

        if (tokenResponse.ok) {
          const tokenData = (await tokenResponse.json()) as any;
          if (tokenData?.token) {
            joinUrl = `${roomBaseUrl}?t=${tokenData.token}`;
          }
        } else {
          const errText = await tokenResponse.text();
          console.warn('Daily.co meeting token generation failed, falling back to basic URL:', errText);
        }
      } catch (err) {
        console.error('Failed to create Daily.co meeting token:', err);
      }
    } else {
      // Simulation/sandbox mode
      useSimulation = true;
    }

    res.json({
      joinable: true,
      gracePeriodActive: true,
      secondsRemainingInGraceWindow,
      notice: 'Please join within 10 minutes or this consultation will need to be rescheduled.',
      joinUrl,
      useSimulation,
      appointmentId: appointment.id,
      patientId: appointment.patient_id,
      doctorUserId: appointment.doctors?.user_id,
      patientName: appointment.users?.full_name || 'Patient',
      doctorName: appointment.doctors?.users?.full_name || 'Dr. Deeba',
    });
  } catch (err) {
    console.error('Join appointment call error:', err);
    res.status(500).json({ error: 'Failed to authorize call entry' });
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
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update appointment' });
      return;
    }

    memoryCache.del('slots:');
    res.json({ appointment: data });
  } catch (err) {
    console.error('Update appointment error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

/**
 * POST /api/appointments/:id/reschedule-request
 * Proposes a new date/time for appointment via chat.
 */
appointmentsRouter.post('/:id/reschedule-request', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { new_date, new_slot_time } = req.body;
    if (!new_date || !new_slot_time) {
      res.status(400).json({ error: 'new_date and new_slot_time are required' });
      return;
    }

    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from('appointments')
      .select('*, doctors(*, users!inner(full_name))')
      .eq('id', req.params.id)
      .single();

    if (apptErr || !appointment) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    // Check if slot is available for doctor on new_date
    const { data: existingSlot } = await supabaseAdmin
      .from('appointments')
      .select('id')
      .eq('doctor_id', appointment.doctor_id)
      .eq('appointment_date', new_date)
      .eq('slot_time', new_slot_time)
      .in('status', ['confirmed', 'pending'])
      .neq('id', appointment.id)
      .maybeSingle();

    if (existingSlot) {
      res.status(409).json({ error: 'Selected time slot is already booked. Please choose another slot.' });
      return;
    }

    // Update appointment status to reschedule_requested
    await supabaseAdmin
      .from('appointments')
      .update({ status: 'reschedule_requested' })
      .eq('id', req.params.id);

    // Find chat conversation between patient & doctor
    const doctorUserId = appointment.doctors?.user_id;
    const patientUserId = appointment.patient_id;

    const { data: convo } = await supabaseAdmin
      .from('chat_conversations')
      .select('id')
      .eq('patient_id', patientUserId)
      .eq('doctor_id', doctorUserId)
      .maybeSingle();

    const formattedDate = new Date(new_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const payloadContent = `[RESCHEDULE_PROPOSAL] Date: ${formattedDate} (${new_date}) | Time: ${new_slot_time} | ApptID: ${req.params.id}`;

    if (convo) {
      await supabaseAdmin
        .from('chat_messages')
        .insert({
          conversation_id: convo.id,
          sender_id: req.userId,
          content: payloadContent,
        });

      await supabaseAdmin
        .from('chat_conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', convo.id);
    }

    res.json({ success: true, message: 'Reschedule request sent to chat.' });
  } catch (err) {
    console.error('Reschedule request error:', err);
    res.status(500).json({ error: 'Failed to process reschedule request' });
  }
});

/**
 * POST /api/appointments/:id/reschedule-accept
 * Accepts a reschedule request and updates the appointment date & time.
 */
appointmentsRouter.post('/:id/reschedule-accept', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { new_date, new_slot_time } = req.body;
    if (!new_date || !new_slot_time) {
      res.status(400).json({ error: 'new_date and new_slot_time are required' });
      return;
    }

    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from('appointments')
      .select('*, doctors(*, users!inner(full_name))')
      .eq('id', req.params.id)
      .single();

    if (apptErr || !appointment) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    // Update appointment
    const { data: updatedAppt, error: updateErr } = await supabaseAdmin
      .from('appointments')
      .update({
        appointment_date: new_date,
        slot_time: new_slot_time,
        status: 'confirmed',
      })
      .eq('id', req.params.id)
      .select('*, doctors(*, users!inner(full_name))')
      .single();

    if (updateErr) {
      res.status(500).json({ error: 'Failed to accept reschedule' });
      return;
    }

    memoryCache.del('slots:');

    // Post confirmation message to chat
    const doctorUserId = appointment.doctors?.user_id;
    const patientUserId = appointment.patient_id;

    const { data: convo } = await supabaseAdmin
      .from('chat_conversations')
      .select('id')
      .eq('patient_id', patientUserId)
      .eq('doctor_id', doctorUserId)
      .maybeSingle();

    const formattedDate = new Date(new_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

    if (convo) {
      await supabaseAdmin
        .from('chat_messages')
        .insert({
          conversation_id: convo.id,
          sender_id: req.userId,
          content: `✅ Reschedule Confirmed! The consultation is set for ${formattedDate} at ${new_slot_time}.`,
        });

      await supabaseAdmin
        .from('chat_conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', convo.id);
    }

    res.json({ success: true, appointment: updatedAppt });
  } catch (err) {
    console.error('Reschedule accept error:', err);
    res.status(500).json({ error: 'Failed to confirm reschedule' });
  }
});

