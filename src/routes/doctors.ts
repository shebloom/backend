import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { memoryCache } from '../lib/cache';

export const doctorsRouter = Router();

/**
 * Helper to ensure Dr. Deepa Madhav is the single doctor record in DB
 * and has a dedicated login credential (dr.deepa@shebloom.com / Doctor@123).
 */
export async function getOrCreateDrDeepa() {
  const doctorEmail = 'dr.deepa@shebloom.com';
  const doctorName = 'Dr. Deepa Madhavan';

  // 1. Find or create Dr. Deepa Madhav user account
  let { data: user } = await supabaseAdmin
    .from('users')
    .select('id, email, full_name, role')
    .eq('email', doctorEmail)
    .maybeSingle();

  if (!user) {
    // Check if user exists in Supabase Auth
    const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
    let authUser = listData?.users?.find(u => u.email?.toLowerCase() === doctorEmail);

    if (!authUser) {
      // Create user via Supabase Auth Admin API with password Doctor@123
      const { data: newAuth, error: authErr } = await supabaseAdmin.auth.admin.createUser({
        email: doctorEmail,
        password: 'Doctor@123',
        email_confirm: true,
        user_metadata: { full_name: doctorName },
      });
      if (authErr) {
        console.error('Error creating Dr. Deepa Madhav auth account:', authErr);
      }
      authUser = newAuth?.user || undefined;
    }

    if (authUser) {
      const { data: newUser } = await supabaseAdmin
        .from('users')
        .upsert(
          {
            id: authUser.id,
            email: doctorEmail,
            full_name: doctorName,
            role: 'doctor',
            avatar_url: '/images/dr_deepa_cutout.png',
          },
          { onConflict: 'id' }
        )
        .select()
        .single();
      user = newUser;
    }
  } else {
    // Ensure role is doctor and name is updated
    await supabaseAdmin
      .from('users')
      .update({ role: 'doctor', full_name: doctorName, avatar_url: '/images/dr_deepa_cutout.png' })
      .eq('id', user.id);
  }

  if (!user) return null;

  // 2. Upsert Dr. Deepa Madhav in public.doctors
  let { data: doctorRecord } = await supabaseAdmin
    .from('doctors')
    .select('*, users!inner(full_name, avatar_url, email)')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!doctorRecord) {
    const { data: newDoctor } = await supabaseAdmin
      .from('doctors')
      .insert({
        user_id: user.id,
        specialty: 'Obstetrics & Gynecology (OB/GYN)',
        experience_years: 15,
        languages: ['English', 'Hindi', 'Malayalam'],
        rating: 4.9,
        review_count: 142,
        about: 'Dr. Deepa Madhav is a renowned Gynecologist and Reproductive Health Specialist with over 15 years of clinical experience in women’s wellness, fertility care, and PCOS management.',
        consultation_fee: 0,
        consultation_type: 'video',
        category: 'Gynecologist',
        license_number: 'MD-GYN-88492',
        current_workplace: 'SheBloom Women’s Health Clinic',
        degrees: ['MBBS', 'MD (OB/GYN)', 'DNB'],
        specialties: ['PCOS & PCOD Management', 'High-Risk Pregnancy', 'Infertility & IVF', 'Menstrual Wellness'],
        status: 'approved',
        slot_duration: 30,
      })
      .select('*, users!inner(full_name, avatar_url, email)')
      .single();

    doctorRecord = newDoctor;
  } else {
    // Update name, role & info if needed
    await supabaseAdmin
      .from('doctors')
      .update({
        specialty: 'Obstetrics & Gynecology (OB/GYN)',
        status: 'approved',
        about: 'Dr. Deepa Madhav is a renowned Gynecologist and Reproductive Health Specialist with over 15 years of clinical experience in women’s wellness, fertility care, and PCOS management.',
      })
      .eq('id', doctorRecord.id);
  }

  // 3. Ensure approved doctor application record exists for Dr. Deepa
  const { data: existingApp } = await supabaseAdmin
    .from('doctor_applications')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!existingApp) {
    await supabaseAdmin.from('doctor_applications').insert({
      user_id: user.id,
      specialty: 'Obstetrics & Gynecology (OB/GYN)',
      experience_years: 15,
      languages: ['English', 'Hindi', 'Malayalam'],
      consultation_fee: 0,
      license_number: 'MD-GYN-88492',
      category: 'Gynecologist',
      status: 'approved',
      reviewed_at: new Date().toISOString(),
    });
  }

  return doctorRecord;
}

// Backward-compatible alias
export const getOrCreateDrDeeba = getOrCreateDrDeepa;

/**
 * GET /api/doctors
 * Returns Dr. Deepa Madhav (Single-Doctor Model with TTL Caching).
 */
doctorsRouter.get('/', async (_req, res) => {
  try {
    const drDeepa = await getOrCreateDrDeepa();
    res.json({ doctors: drDeepa ? [drDeepa] : [] });
  } catch (err) {
    console.error('Get doctors error:', err);
    res.status(500).json({ error: 'Failed to fetch doctor' });
  }
});

/**
 * GET /api/doctors/:id
 * Returns Dr. Deepa Madhav's profile.
 */
doctorsRouter.get('/:id', async (_req, res) => {
  try {
    const drDeepa = await getOrCreateDrDeepa();
    if (!drDeepa) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }
    res.json({ doctor: drDeepa });
  } catch (err) {
    console.error('Get doctor error:', err);
    res.status(500).json({ error: 'Failed to fetch doctor' });
  }
});

/**
 * GET /api/doctors/:id/slots
 * Returns available time slots for Dr. Deepa Madhav on a given date.
 */
doctorsRouter.get('/:id/slots', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || typeof date !== 'string') {
      res.status(400).json({ error: 'date query parameter is required (YYYY-MM-DD)' });
      return;
    }

    const isToday = new Date().toLocaleDateString('en-CA') === date; // YYYY-MM-DD
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const cacheKey = `slots:${date}`;
    if (!isToday) {
      const cachedSlots = memoryCache.get(cacheKey);
      if (cachedSlots) {
        res.json(cachedSlots);
        return;
      }
    }

    const drDeepa = await getOrCreateDrDeepa();
    if (!drDeepa) {
      res.status(404).json({ error: 'Doctor not found' });
      return;
    }

    const doctorId = drDeepa.id;
    const requestedDate = new Date(date);
    const dayOfWeek = requestedDate.getDay();

    const { data: availability } = await supabaseAdmin
      .from('doctor_availability')
      .select('*')
      .eq('doctor_id', doctorId)
      .eq('day_of_week', dayOfWeek);

    const duration = drDeepa.slot_duration || 30;

    const { data: bookedSlots } = await supabaseAdmin
      .from('appointments')
      .select('id, slot_time, status, patient_id, users!appointments_patient_id_fkey(full_name)')
      .eq('doctor_id', doctorId)
      .eq('appointment_date', date)
      .in('status', ['confirmed', 'pending']);

    const bookedMap = new Map<string, any>();
    (bookedSlots || []).forEach((b: any) => {
      let timeStr = typeof b.slot_time === 'string' ? b.slot_time.substring(0, 5) : b.slot_time;
      bookedMap.set(timeStr, b);
    });

    const windows = (availability && availability.length > 0)
      ? availability
      : [
          { start_time: '09:00', end_time: '13:00' },
          { start_time: '15:00', end_time: '19:00' },
        ];

    const slots: { time: string; isBooked: boolean; booking?: any }[] = [];
    for (const w of windows) {
      let current = parseTime(w.start_time);
      const end = parseTime(w.end_time);
      while (current < end) {
        const timeStr = formatTime(current);
        const booking = bookedMap.get(timeStr);
        
        // Skip past slot times if booking for today
        if (!isToday || current > nowMinutes) {
          slots.push({
            time: timeStr,
            isBooked: !!booking,
            booking: booking ? { id: booking.id, patient_name: booking.users?.full_name } : undefined,
          });
        }
        current += duration;
      }
    }

    const payload = { slots, date, doctor: drDeepa };
    if (!isToday) {
      memoryCache.set(cacheKey, payload, 60);
    }
    res.json(payload);
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

function parseTime(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
