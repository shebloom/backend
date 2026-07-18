import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth';

export const doctorsRouter = Router();

/**
 * GET /api/doctors
 * Returns all approved doctors. Supports ?search= and ?category= query params.
 */
doctorsRouter.get('/', async (req, res) => {
  try {
    const { search, category } = req.query;

    let query = supabaseAdmin
      .from('doctors')
      .select('*, users!inner(full_name, avatar_url)')
      .eq('status', 'approved');

    if (category && category !== 'All') {
      query = query.eq('category', category);
    }

    const { data, error } = await query.order('rating', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch doctors' });
      return;
    }

    let results = data || [];

    // Client-side search filter (name or tags)
    if (search && typeof search === 'string') {
      const term = search.toLowerCase();
      results = results.filter((d: any) => {
        const matchesName = d.users.full_name?.toLowerCase().includes(term);
        const matchesSpecialty = d.specialty?.toLowerCase().includes(term);
        const matchesSpecialtiesArray = d.specialties?.some((s: string) => s.toLowerCase().includes(term));
        const matchesDegrees = d.degrees?.some((deg: string) => deg.toLowerCase().includes(term));
        const matchesUniversities = d.universities?.some((uni: string) => uni.toLowerCase().includes(term));
        
        return matchesName || matchesSpecialty || matchesSpecialtiesArray || matchesDegrees || matchesUniversities;
      });
    }

    res.json({ doctors: results });
  } catch (err) {
    console.error('Get doctors error:', err);
    res.status(500).json({ error: 'Failed to fetch doctors' });
  }
});

/**
 * GET /api/doctors/:id
 * Returns a single doctor's full profile.
 */
doctorsRouter.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('doctors')
      .select('*, users!inner(full_name, avatar_url, email)')
      .eq('id', req.params.id)
      .eq('status', 'approved')
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }

    res.json({ doctor: data });
  } catch (err) {
    console.error('Get doctor error:', err);
    res.status(500).json({ error: 'Failed to fetch doctor' });
  }
});

/**
 * GET /api/doctors/:id/slots
 * Returns available time slots for a doctor on a given date.
 */
doctorsRouter.get('/:id/slots', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      res.status(400).json({ error: 'date query parameter is required' });
      return;
    }

    // Fetch doctor's availability for the day of week
    const requestedDate = new Date(date as string);
    const dayOfWeek = requestedDate.getDay();

    const { data: availability } = await supabaseAdmin
      .from('doctor_availability')
      .select('*')
      .eq('doctor_id', req.params.id)
      .eq('day_of_week', dayOfWeek);

    // Fetch doctor's custom slot_duration
    const { data: doctor } = await supabaseAdmin
      .from('doctors')
      .select('slot_duration')
      .eq('id', req.params.id)
      .single();

    const duration = doctor?.slot_duration || 30;

    // Fetch existing appointments for that date to check booked slots
    const { data: bookedSlots } = await supabaseAdmin
      .from('appointments')
      .select('slot_time')
      .eq('doctor_id', req.params.id)
      .eq('appointment_date', date)
      .in('status', ['confirmed', 'pending']);

    const bookedTimes = new Set(
      (bookedSlots || []).map((s: any) => {
        if (typeof s.slot_time === 'string') {
          return s.slot_time.substring(0, 5); // Normalize "HH:MM:SS" to "HH:MM"
        }
        return s.slot_time;
      })
    );

    // Generate available slots from availability windows
    const slots: { time: string, isBooked: boolean }[] = [];
    for (const window of availability || []) {
      let current = parseTime(window.start_time);
      const end = parseTime(window.end_time);
      while (current < end) {
        const timeStr = formatTime(current);
        const isBooked = bookedTimes.has(timeStr);
        slots.push({ time: timeStr, isBooked });
        current += duration; // Use doctor's custom slot duration (time gap)
      }
    }

    res.json({ slots, date });
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

/**
 * POST /api/doctors/apply
 * Submit a doctor application
 */
doctorsRouter.post('/apply', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { specialty, experience_years, languages, consultation_fee, consultation_type, category, license_number, document_urls, slot_duration } = req.body;

    // Check if they already applied
    const { data: existingApps } = await supabaseAdmin
      .from('doctor_applications')
      .select('id, status')
      .eq('user_id', req.userId);

    const pendingOrApproved = existingApps?.find(a => a.status === 'pending' || a.status === 'approved');
    if (pendingOrApproved) {
      res.status(400).json({ error: 'You already have a pending or approved application.' });
      return;
    }

    const { data: user } = await supabaseAdmin.from('users').select('rejection_count').eq('id', req.userId).single();
    if ((user?.rejection_count || 0) >= 3) {
      res.status(403).json({ error: 'Maximum application attempts reached.' });
      return;
    }

    // Delete old rejected applications to keep it clean
    if (existingApps && existingApps.length > 0) {
      await supabaseAdmin.from('doctor_applications').delete().eq('user_id', req.userId);
    }

    // Insert application
    const { data: app, error: appError } = await supabaseAdmin
      .from('doctor_applications')
      .insert({
        user_id: req.userId,
        specialty,
        experience_years,
        languages: languages || [],
        consultation_fee,
        consultation_type,
        category,
        license_number,
        slot_duration: slot_duration || 30
      })
      .select('id')
      .single();

    if (appError) {
      res.status(500).json({ error: 'Failed to submit application' });
      return;
    }

    // Insert documents if any
    if (document_urls && document_urls.length > 0) {
      const docs = document_urls.map((url: string) => ({
        application_id: app.id,
        document_type: 'license', // simplifying for now
        file_url: url
      }));
      await supabaseAdmin.from('doctor_documents').insert(docs);
    }

    res.json({ success: true, application_id: app.id });
  } catch (err) {
    console.error('Doctor apply error:', err);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

function parseTime(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

