import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { memoryCache } from '../lib/cache';
import { CONSULTATION_JOIN_WINDOW_MS, CONSULTATION_JOIN_WINDOW_MINUTES, parseAppointmentTimeAsIST } from '../lib/constants';

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

    // Broadcast realtime notification to Doctor
    try {
      const { data: docRecord } = await supabaseAdmin
        .from('doctors')
        .select('user_id')
        .eq('id', doctor_id)
        .maybeSingle();

      const { data: patientUser } = await supabaseAdmin
        .from('users')
        .select('full_name, avatar_url')
        .eq('id', req.userId)
        .maybeSingle();

      if (docRecord?.user_id) {
        const notifChannel = supabaseAdmin.channel('shebloom-notifications');
        notifChannel.send({
          type: 'broadcast',
          event: 'new_appointment_booked',
          payload: {
            appointmentId: data?.id || tempId,
            doctorId: docRecord.user_id,
            recipientId: docRecord.user_id,
            patientId: req.userId,
            patientName: patientUser?.full_name || 'Patient',
            patientAvatar: patientUser?.avatar_url,
            date: appointment_date,
            slot: slot_time,
          },
        });
      }
    } catch (bcErr) {
      console.warn('New appointment broadcast error:', bcErr);
    }

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
 * Automatically queries by doctor_id if the caller is a Doctor account.
 */
appointmentsRouter.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { status, upcoming } = req.query;

    let query = supabaseAdmin
      .from('appointments')
      .select('*, doctors(*, users!inner(full_name, avatar_url))');

    if (req.userRole === 'doctor') {
      const { data: docRecord } = await supabaseAdmin
        .from('doctors')
        .select('id')
        .eq('user_id', req.userId)
        .maybeSingle();

      if (docRecord?.id) {
        query = query.eq('doctor_id', docRecord.id);
      } else {
        query = query.eq('patient_id', req.userId);
      }
    } else {
      query = query.eq('patient_id', req.userId);
    }

    if (status) {
      query = query.eq('status', status);
    }

    if (upcoming === 'true') {
      query = query
        .gte('appointment_date', new Date().toISOString().split('T')[0])
        .in('status', ['confirmed', 'pending', 'rescheduled', 'completed'])
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
    const missedIds: string[] = [];

    // Process appointments with 10-minute grace period enforcement
    let formatted = (data || []).map((a: any) => {
      const scheduledDateTime = parseAppointmentTimeAsIST(a.appointment_date, a.slot_time);
      const graceEnd = new Date(scheduledDateTime.getTime() + CONSULTATION_JOIN_WINDOW_MS);

      const isTooEarly = now < scheduledDateTime;
      const isJoinableWindow = now >= scheduledDateTime && now <= graceEnd;
      const isPastGrace = now > graceEnd;

      let displayStatus = a.status;
      if (isPastGrace && ['confirmed', 'pending', 'rescheduled'].includes(a.status)) {
        displayStatus = 'missed';
        missedIds.push(a.id);
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

    if (missedIds.length > 0) {
      Promise.resolve(
        supabaseAdmin
          .from('appointments')
          .update({ status: 'missed' })
          .in('id', missedIds)
      ).catch((err: any) => console.error('Batch missed status update error:', err));
    }

    if (upcoming === 'true') {
      formatted = formatted.filter((a: any) => {
        // Include 'completed' so already-joined appointments remain joinable during the window
        return (a.is_joinable || a.is_too_early) && ['confirmed', 'pending', 'rescheduled', 'completed'].includes(a.display_status);
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
    let isDoctor =
      req.userId === appointment.doctors?.user_id ||
      req.userId === appointment.doctor_id ||
      req.userRole === 'doctor';

    if (!isPatient && !isDoctor) {
      // Direct doctor table query check
      const { data: docRec } = await supabaseAdmin
        .from('doctors')
        .select('id, user_id')
        .or(`id.eq.${appointment.doctor_id},user_id.eq.${req.userId}`)
        .maybeSingle();

      if (docRec && (docRec.user_id === req.userId || docRec.id === appointment.doctor_id)) {
        isDoctor = true;
      }
    }

    if (!isPatient && !isDoctor) {
      res.status(403).json({ error: 'You are not authorized to join this call' });
      return;
    }

    // Validate appointment status — allow joining active appointments AND already-in-progress ones
    // 'completed' is included here because the join endpoint sets it prematurely (kept for idempotency)
    const isActiveStatus = ['confirmed', 'pending', 'rescheduled', 'completed'].includes(appointment.status);

    if (!isActiveStatus) {
      res.json({
        joinable: false,
        reason: 'inactive',
        error: `This appointment status is '${appointment.status}'. Only active appointments can be joined.`,
      });
      return;
    }

    // ── TIMEZONE-SAFE: slot_time is stored in IST; convert to UTC for server-side comparison ──
    const now = new Date();
    const scheduledStart = parseAppointmentTimeAsIST(appointment.appointment_date, appointment.slot_time);
    const graceEnd = new Date(scheduledStart.getTime() + CONSULTATION_JOIN_WINDOW_MS);

    // ── BOTH BOUNDARIES: is_joinable = (now >= scheduledStart) AND (now <= graceEnd) ──
    const isTooEarly   = now < scheduledStart;
    const isJoinable   = now >= scheduledStart && now <= graceEnd;
    const isPastGrace  = now > graceEnd;
    const secondsRemainingInGraceWindow = isJoinable
      ? Math.max(0, Math.floor((graceEnd.getTime() - now.getTime()) / 1000))
      : 0;

    // ── DEBUG LOGGING ──────────────────────────────────────────────────────────────────────────
    console.log(`[JOIN] appointmentId=${appointmentId}`);
    console.log(`[JOIN] appointment_date=${appointment.appointment_date} slot_time=${appointment.slot_time}`);
    console.log(`[JOIN] scheduledStart (UTC): ${scheduledStart.toISOString()}`);
    console.log(`[JOIN] now            (UTC): ${now.toISOString()}`);
    console.log(`[JOIN] graceEnd       (UTC): ${graceEnd.toISOString()}`);
    console.log(`[JOIN] isTooEarly=${isTooEarly} | isJoinable=${isJoinable} | isPastGrace=${isPastGrace}`);
    // ──────────────────────────────────────────────────────────────────────────────────────────

    // ── START BOUNDARY: block early joins server-side, no exception ──
    if (isTooEarly) {
      const minutesUntilStart = Math.ceil((scheduledStart.getTime() - now.getTime()) / 60000);
      res.json({
        joinable: false,
        reason: 'too_early',
        error: `This consultation starts in ${minutesUntilStart} minute${minutesUntilStart !== 1 ? 's' : ''}. You cannot join before the scheduled time.`,
        scheduledStart: scheduledStart.toISOString(),
        minutesUntilStart,
      });
      return;
    }

    // ── END BOUNDARY: block joins after the grace window has expired ──
    if (isPastGrace) {
      // Auto-mark as missed if it wasn't already
      if (['confirmed', 'pending', 'rescheduled'].includes(appointment.status)) {
        await supabaseAdmin.from('appointments').update({ status: 'missed' }).eq('id', appointmentId);
      }
      res.json({
        joinable: false,
        reason: 'expired',
        error: `The ${CONSULTATION_JOIN_WINDOW_MINUTES}-minute join window for this consultation has expired. Please reschedule.`,
        expiredAt: graceEnd.toISOString(),
      });
      return;
    }

    // ── DOCTOR-INITIATED CALL GATE ──
    // Patient cannot join until doctor has clicked "Start Call" (appointment.call_started === true)
    if (isPatient && !isDoctor && !appointment.call_started) {
      res.json({
        joinable: false,
        reason: 'waiting_for_doctor',
        error: `Waiting for ${appointment.doctors?.users?.full_name || 'Dr. Deepa Madhavan'} to start the call. Please stay on this screen.`,
        call_started: false,
      });
      return;
    }

    // ── WITHIN ACTIVE WINDOW (now >= scheduledStart && now <= graceEnd) ──
    // NOTE: Do NOT update status to 'completed' here — that would immediately remove the
    // appointment from the 'upcoming' list and the join window would vanish for both parties.
    // Status transitions: confirmed/rescheduled → (stays active during window) → completed (post-call)
    // The 'completed' write is intentionally deferred; it happens separately when the call ends.

    const cleanHash = appointment.id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
    let roomBaseUrl = appointment.video_room_url;

    if (!roomBaseUrl || roomBaseUrl.includes('shebloom.daily.co') || roomBaseUrl.includes('#config')) {
      roomBaseUrl = `https://meet.jit.si/SheBloomConsult${cleanHash}`;
      // Only update the room URL — do NOT touch status here
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
      notice: `Please join within ${CONSULTATION_JOIN_WINDOW_MINUTES} minutes of your scheduled time or this consultation will need to be rescheduled.`,
      joinUrl,
      useSimulation,
      appointmentId: appointment.id,
      patientId: appointment.patient_id,
      doctorUserId: appointment.doctors?.user_id,
      patientName: appointment.users?.full_name || 'Patient',
      doctorName: appointment.doctors?.users?.full_name || 'Dr. Deeba',
      call_started: !!appointment.call_started,
    });
  } catch (err) {
    console.error('Join appointment call error:', err);
    res.status(500).json({ error: 'Failed to authorize call entry' });
  }
});

/**
 * POST /api/appointments/:id/start-call
 * Doctor initiates the call during the scheduled window.
 */
appointmentsRouter.post('/:id/start-call', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const appointmentId = req.params.id;
    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from('appointments')
      .select('*, doctors(*, users!inner(full_name, avatar_url)), users!appointments_patient_id_fkey(full_name)')
      .eq('id', appointmentId)
      .single();

    if (apptErr || !appointment) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const isDoctor = req.userId === appointment.doctors?.user_id || req.userId === appointment.doctor_id || req.userRole === 'doctor';
    if (!isDoctor) {
      res.status(403).json({ error: 'Only the assigned doctor can initiate the consultation call' });
      return;
    }

    const now = new Date();
    const scheduledStart = parseAppointmentTimeAsIST(appointment.appointment_date, appointment.slot_time);
    const graceEnd = new Date(scheduledStart.getTime() + CONSULTATION_JOIN_WINDOW_MS);

    if (now < scheduledStart) {
      res.status(400).json({ error: 'Cannot start call before the scheduled time' });
      return;
    }
    if (now > graceEnd) {
      res.status(400).json({ error: 'The consultation join window has expired' });
      return;
    }

    const nowIso = now.toISOString();
    await supabaseAdmin
      .from('appointments')
      .update({
        call_started: true,
        call_started_at: nowIso,
        doctor_joined_at: nowIso,
      })
      .eq('id', appointmentId);

    // Record presence event for doctor
    try {
      await supabaseAdmin
        .from('appointment_presence_events')
        .insert({
          appointment_id: appointmentId,
          user_id: req.userId,
          role: 'doctor',
          event_type: 'joined',
        });
    } catch (e) {}

    // Broadcast incoming_call realtime event to patient
    const cleanHash = appointment.id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
    const roomUrl = appointment.video_room_url || `https://meet.jit.si/SheBloomConsult${cleanHash}`;
    const payload = {
      appointmentId: appointment.id,
      callerId: req.userId,
      callerName: appointment.doctors?.users?.full_name || 'Dr. Deepa Madhavan',
      callerAvatar: appointment.doctors?.users?.avatar_url,
      recipientId: appointment.patient_id,
      doctorId: req.userId,
      patientId: appointment.patient_id,
      roomUrl,
      date: appointment.appointment_date,
      slot: appointment.slot_time,
      expiresAt: Date.now() + 15 * 60 * 1000,
    };

    try {
      const roomChannel = supabaseAdmin.channel(`appointment-room-${appointmentId}`, {
        config: { broadcast: { self: false } },
      });
      roomChannel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          roomChannel.send({ type: 'broadcast', event: 'incoming_call', payload }).catch(() => {});
        }
      });
      roomChannel.send({ type: 'broadcast', event: 'incoming_call', payload }).catch(() => {});

      const notifChannel = supabaseAdmin.channel('shebloom-notifications');
      notifChannel.send({ type: 'broadcast', event: 'incoming_call', payload }).catch(() => {});
    } catch (bcErr) {
      console.warn('[start-call] Broadcast notice warning:', bcErr);
    }

    res.json({
      success: true,
      call_started: true,
      joinUrl: roomUrl,
      appointmentId: appointment.id,
    });
  } catch (err: any) {
    console.error('Start call error:', err);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

/**
 * POST /api/appointments/:id/events/presence
 * Tracks participant joined and left timestamps for server-side overlap calculation.
 */
appointmentsRouter.post('/:id/events/presence', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const appointmentId = req.params.id;
    const { event } = req.body;
    if (!['joined', 'left'].includes(event)) {
      res.status(400).json({ error: 'Invalid presence event type' });
      return;
    }

    const { data: appt } = await supabaseAdmin
      .from('appointments')
      .select('id, patient_id, doctor_id, doctors(user_id)')
      .eq('id', appointmentId)
      .single();

    if (!appt) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const docUserId = Array.isArray(appt.doctors) ? appt.doctors[0]?.user_id : (appt.doctors as any)?.user_id;
    const isDoctor = req.userId === docUserId || req.userId === appt.doctor_id || req.userRole === 'doctor';
    const role = isDoctor ? 'doctor' : 'patient';
    const nowIso = new Date().toISOString();

    try {
      await supabaseAdmin
        .from('appointment_presence_events')
        .insert({
          appointment_id: appointmentId,
          user_id: req.userId,
          role,
          event_type: event,
        });
    } catch (e) {}

    const updateFields: Record<string, any> = {};
    if (role === 'doctor') {
      if (event === 'joined') updateFields.doctor_joined_at = nowIso;
      if (event === 'left') updateFields.doctor_left_at = nowIso;
    } else {
      if (event === 'joined') updateFields.patient_joined_at = nowIso;
      if (event === 'left') updateFields.patient_left_at = nowIso;
    }

    if (Object.keys(updateFields).length > 0) {
      await supabaseAdmin.from('appointments').update(updateFields).eq('id', appointmentId);
    }

    res.json({ success: true, role, event });
  } catch (err: any) {
    console.error('Presence event error:', err);
    res.status(500).json({ error: 'Failed to record presence event' });
  }
});

/**
 * POST /api/appointments/:id/end
 * Ends call session and server-verifies overlapping participant presence before marking completed.
 */
appointmentsRouter.post('/:id/end', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const appointmentId = req.params.id;
    const { data: appt } = await supabaseAdmin
      .from('appointments')
      .select('*')
      .eq('id', appointmentId)
      .single();

    if (!appt) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const { data: events } = await supabaseAdmin
      .from('appointment_presence_events')
      .select('*')
      .eq('appointment_id', appointmentId)
      .order('created_at', { ascending: true });

    const allEvents = events || [];
    const docEvents = allEvents.filter(e => e.role === 'doctor');
    const patEvents = allEvents.filter(e => e.role === 'patient');

    const docJoined = appt.doctor_joined_at ? new Date(appt.doctor_joined_at).getTime() : null;
    const docLeft = appt.doctor_left_at ? new Date(appt.doctor_left_at).getTime() : null;
    const patJoined = appt.patient_joined_at ? new Date(appt.patient_joined_at).getTime() : null;
    const patLeft = appt.patient_left_at ? new Date(appt.patient_left_at).getTime() : null;

    const hasDoctorJoined = docEvents.some(e => e.event_type === 'joined') || docJoined !== null;
    const hasPatientJoined = patEvents.some(e => e.event_type === 'joined') || patJoined !== null;

    const getIntervals = (roleEvents: any[], firstJoin: number | null, lastLeft: number | null) => {
      const intervals: { joined: number; left: number }[] = [];
      let currentJoin: number | null = firstJoin;
      for (const ev of roleEvents) {
        const time = new Date(ev.created_at).getTime();
        if (ev.event_type === 'joined') {
          currentJoin = time;
        } else if (ev.event_type === 'left' && currentJoin !== null) {
          intervals.push({ joined: currentJoin, left: time });
          currentJoin = null;
        }
      }
      if (currentJoin !== null) {
        intervals.push({ joined: currentJoin, left: lastLeft || Date.now() });
      }
      return intervals;
    };

    const docIntervals = getIntervals(docEvents, docJoined, docLeft);
    const patIntervals = getIntervals(patEvents, patJoined, patLeft);

    let maxOverlapMs = 0;
    for (const d of docIntervals) {
      for (const p of patIntervals) {
        const overlapStart = Math.max(d.joined, p.joined);
        const overlapEnd = Math.min(d.left, p.left);
        if (overlapEnd > overlapStart) {
          maxOverlapMs += (overlapEnd - overlapStart);
        }
      }
    }

    const now = new Date();
    const scheduledStart = parseAppointmentTimeAsIST(appt.appointment_date, appt.slot_time);
    const graceEnd = new Date(scheduledStart.getTime() + CONSULTATION_JOIN_WINDOW_MS);
    const isWindowStillActive = now <= graceEnd;

    let finalStatus = appt.status;
    let noShowType: string | null = null;

    if (maxOverlapMs > 0) {
      finalStatus = 'completed';
      noShowType = null;
    } else if (isWindowStillActive) {
      // Window is still active (e.g., doctor exited call room early or patient declined)
      // Do NOT set to missed while the window is still open! Keep status active.
      finalStatus = ['confirmed', 'pending', 'rescheduled'].includes(appt.status) ? appt.status : 'confirmed';
      noShowType = null;
    } else if (hasDoctorJoined && !hasPatientJoined) {
      finalStatus = 'missed';
      noShowType = 'patient_no_show';
    } else if (hasPatientJoined && !hasDoctorJoined) {
      finalStatus = 'missed';
      noShowType = 'doctor_no_show';
    } else if (!hasDoctorJoined && !hasPatientJoined) {
      finalStatus = 'missed';
      noShowType = 'no_show';
    } else {
      finalStatus = 'missed';
      noShowType = 'no_overlap';
    }

    await supabaseAdmin.from('appointments').update({
      status: finalStatus,
      no_show_type: noShowType,
      updated_at: new Date().toISOString(),
    }).eq('id', appointmentId);

    res.json({
      success: true,
      status: finalStatus,
      no_show_type: noShowType,
      overlapSeconds: Math.floor(maxOverlapMs / 1000),
      hasDoctorJoined,
      hasPatientJoined,
    });
  } catch (err: any) {
    console.error('End call error:', err);
    res.status(500).json({ error: 'Failed to evaluate call presence' });
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

    // Broadcast realtime reschedule notification
    try {
      const { data: senderUser } = await supabaseAdmin
        .from('users')
        .select('full_name')
        .eq('id', req.userId)
        .maybeSingle();

      const recipientUserId = req.userId === patientUserId ? doctorUserId : patientUserId;
      if (recipientUserId) {
        const notifChannel = supabaseAdmin.channel('shebloom-notifications');
        notifChannel.send({
          type: 'broadcast',
          event: 'appointment_rescheduled',
          payload: {
            appointmentId: req.params.id,
            rescheduledBy: req.userId,
            rescheduledByName: senderUser?.full_name || (req.userRole === 'doctor' ? 'Dr. Deepa Madhavan' : 'Patient'),
            recipientId: recipientUserId,
            doctorId: doctorUserId,
            patientId: patientUserId,
            newDate: new_date,
            newSlot: new_slot_time,
          },
        });
      }
    } catch (bcErr) {
      console.warn('Reschedule broadcast error:', bcErr);
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

    // Broadcast confirmation notification
    try {
      const { data: senderUser } = await supabaseAdmin
        .from('users')
        .select('full_name')
        .eq('id', req.userId)
        .maybeSingle();

      const recipientUserId = req.userId === patientUserId ? doctorUserId : patientUserId;
      if (recipientUserId) {
        const notifChannel = supabaseAdmin.channel('shebloom-notifications');
        notifChannel.send({
          type: 'broadcast',
          event: 'appointment_rescheduled',
          payload: {
            appointmentId: req.params.id,
            rescheduledBy: req.userId,
            rescheduledByName: senderUser?.full_name || (req.userRole === 'doctor' ? 'Dr. Deepa Madhavan' : 'Patient'),
            recipientId: recipientUserId,
            doctorId: doctorUserId,
            patientId: patientUserId,
            newDate: new_date,
            newSlot: new_slot_time,
          },
        });
      }
    } catch (bcErr) {
      console.warn('Reschedule accept broadcast error:', bcErr);
    }

    res.json({ success: true, appointment: updatedAppt });
  } catch (err) {
    console.error('Reschedule accept error:', err);
    res.status(500).json({ error: 'Failed to accept reschedule request' });
  }
});

/**
 * POST /api/appointments/:id/complete
 * Manually mark an appointment as completed when consultation finishes.
 */
appointmentsRouter.post('/:id/complete', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const appointmentId = req.params.id;
    // Enforce presence verification on complete route by checking overlapping presence
    const { data: events } = await supabaseAdmin
      .from('appointment_presence_events')
      .select('*')
      .eq('appointment_id', appointmentId);

    const hasEvents = events && events.length > 0;
    if (!hasEvents) {
      res.status(400).json({ error: 'Cannot complete appointment without verified call presence events' });
      return;
    }

    // Delegate to server-side end endpoint logic
    const { data: appt } = await supabaseAdmin.from('appointments').select('*').eq('id', appointmentId).single();
    if (!appt) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    res.json({ success: true, appointment: appt });
  } catch (err) {
    console.error('Complete appointment error:', err);
    res.status(500).json({ error: 'Failed to complete appointment' });
  }
});
