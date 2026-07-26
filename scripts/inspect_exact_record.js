const { Client } = require('pg');

const connectionString = 'postgresql://postgres:Shebloom%402026@db.unmrwkifhdgtjupicmzv.supabase.co:5432/postgres';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function inspect() {
  try {
    await client.connect();
    console.log('--- DB INSPECTION START ---');

    // 1. Find user Gayathri Mukundan
    const userRes = await client.query(`
      SELECT id, full_name, email, role, created_at 
      FROM public.users 
      WHERE full_name ILIKE '%Gayathri%' OR email ILIKE '%gayathri%';
    `);
    console.log('\n[1] User search results:');
    console.table(userRes.rows);

    const userIds = userRes.rows.map(r => r.id);

    // 2. Find appointments for this user on 2026-07-26 or matching slot 11:30
    let apptRes;
    if (userIds.length > 0) {
      apptRes = await client.query(`
        SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.slot_time, a.status, 
               a.call_started, a.call_started_at, a.doctor_joined_at, a.doctor_left_at, 
               a.patient_joined_at, a.patient_left_at, a.no_show_type, a.created_at, a.updated_at,
               u.full_name as patient_name
        FROM public.appointments a
        LEFT JOIN public.users u ON u.id = a.patient_id
        WHERE a.patient_id = ANY($1::uuid[]) OR a.appointment_date = '2026-07-26'
        ORDER BY a.created_at DESC;
      `, [userIds]);
    } else {
      apptRes = await client.query(`
        SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.slot_time, a.status, 
               a.call_started, a.call_started_at, a.doctor_joined_at, a.doctor_left_at, 
               a.patient_joined_at, a.patient_left_at, a.no_show_type, a.created_at, a.updated_at,
               u.full_name as patient_name
        FROM public.appointments a
        LEFT JOIN public.users u ON u.id = a.patient_id
        WHERE a.appointment_date = '2026-07-26' OR a.slot_time = '11:30:00'
        ORDER BY a.created_at DESC;
      `);
    }

    console.log('\n[2] Matching Appointments:');
    console.table(apptRes.rows);

    // 3. Inspect presence events for these appointments
    const apptIds = apptRes.rows.map(r => r.id);
    if (apptIds.length > 0) {
      const presenceRes = await client.query(`
        SELECT * FROM public.appointment_presence_events
        WHERE appointment_id = ANY($1::uuid[])
        ORDER BY created_at ASC;
      `, [apptIds]);
      console.log('\n[3] Presence events for matching appointments:');
      console.table(presenceRes.rows);

      // Check if prescriptions/health records were created around updated_at
      const rxRes = await client.query(`
        SELECT id, patient_id, record_type, record_date, created_at, updated_at
        FROM public.health_records
        WHERE patient_id = ANY($1::uuid[]) OR record_type = 'prescription'
        ORDER BY created_at DESC LIMIT 10;
      `, [userIds.length > 0 ? userIds : ['00000000-0000-0000-0000-000000000000']]);
      console.log('\n[4] Related Health Records / Prescriptions:');
      console.table(rxRes.rows);
    }

    // 5. Find ALL appointments with status = 'completed' where date >= '2026-07-26'
    const futureCompleted = await client.query(`
      SELECT a.id, a.patient_id, a.doctor_id, a.appointment_date, a.slot_time, a.status,
             a.doctor_joined_at, a.patient_joined_at, a.updated_at, u.full_name as patient_name
      FROM public.appointments a
      LEFT JOIN public.users u ON u.id = a.patient_id
      WHERE a.status = 'completed' AND a.appointment_date >= '2026-07-26'
      ORDER BY a.appointment_date ASC;
    `);
    console.log('\n[5] All appointments marked completed on or after today (2026-07-26):');
    console.table(futureCompleted.rows);

    console.log('--- DB INSPECTION END ---');
  } catch (err) {
    console.error('Inspection error:', err);
  } finally {
    await client.end();
  }
}

inspect();
