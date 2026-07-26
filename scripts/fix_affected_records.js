const { Client } = require('pg');

const connectionString = 'postgresql://postgres:Shebloom%402026@db.unmrwkifhdgtjupicmzv.supabase.co:5432/postgres';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function fixRecords() {
  try {
    await client.connect();
    console.log('--- FIXING AFFECTED APPOINTMENT RECORDS ---');

    // 1. Correct today's appointment (7d2ebeae-4232-4b47-8813-e5abcd63472f) back to 'confirmed'
    const todayRes = await client.query(`
      UPDATE public.appointments
      SET status = 'confirmed', call_started = false, updated_at = NOW()
      WHERE id = '7d2ebeae-4232-4b47-8813-e5abcd63472f'
      RETURNING id, status, appointment_date, slot_time;
    `);
    console.log('1. Corrected today 11:30 AM appointment status:');
    console.table(todayRes.rows);

    // 2. Find past completed appointments with no presence events and update them to 'missed'
    const pastRes = await client.query(`
      UPDATE public.appointments a
      SET status = 'missed', no_show_type = 'no_show', updated_at = NOW()
      WHERE a.status = 'completed'
        AND a.id != '7d2ebeae-4232-4b47-8813-e5abcd63472f'
        AND NOT EXISTS (
          SELECT 1 FROM public.appointment_presence_events p 
          WHERE p.appointment_id = a.id
        )
      RETURNING a.id, a.patient_id, a.appointment_date, a.slot_time, a.status, a.no_show_type;
    `);
    console.log('\n2. Corrected past unverified appointments without presence events to "missed":');
    console.table(pastRes.rows);

    console.log('--- FIX COMPLETED ---');
  } catch (err) {
    console.error('Fix error:', err);
  } finally {
    await client.end();
  }
}

fixRecords();
