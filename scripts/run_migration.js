const { Client } = require('pg');

const connectionString = 'postgresql://postgres:Shebloom%402026@db.unmrwkifhdgtjupicmzv.supabase.co:5432/postgres';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function run() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database successfully.');

    // 1. Add attachment_url to chat_messages
    console.log('Adding attachment_url to chat_messages...');
    await client.query(`
      ALTER TABLE public.chat_messages 
      ADD COLUMN IF NOT EXISTS attachment_url TEXT;
    `);
    console.log('Successfully added attachment_url.');

    // 2. Add content and benefits to wellness_programs
    console.log('Adding content and benefits to wellness_programs...');
    await client.query(`
      ALTER TABLE public.wellness_programs 
      ADD COLUMN IF NOT EXISTS content TEXT,
      ADD COLUMN IF NOT EXISTS benefits TEXT;
    `);
    console.log('Successfully added content and benefits columns.');

    // 3. Add storage policies for doctor-documents
    console.log('Setting up storage policies for doctor-documents...');
    await client.query(`
      -- Ensure bucket exists
      INSERT INTO storage.buckets (id, name, public)
      VALUES ('doctor-documents', 'doctor-documents', true)
      ON CONFLICT (id) DO NOTHING;

      -- Allow inserts into doctor-documents
      DROP POLICY IF EXISTS "Allow public uploads to doctor-documents" ON storage.objects;
      CREATE POLICY "Allow public uploads to doctor-documents"
      ON storage.objects
      FOR INSERT
      TO public
      WITH CHECK (bucket_id = 'doctor-documents');

      -- Allow select from doctor-documents
      DROP POLICY IF EXISTS "Allow public read from doctor-documents" ON storage.objects;
      CREATE POLICY "Allow public read from doctor-documents"
      ON storage.objects
      FOR SELECT
      TO public
      USING (bucket_id = 'doctor-documents');
    `);
    console.log('Successfully set up storage policies.');

    // 4. Add call initiation & presence columns to appointments
    console.log('Adding call initiation and presence columns to appointments...');
    await client.query(`
      ALTER TABLE public.appointments
      ADD COLUMN IF NOT EXISTS call_started BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS call_started_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS doctor_joined_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS doctor_left_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS patient_joined_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS patient_left_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS no_show_type TEXT;
    `);
    console.log('Successfully added call initiation and presence columns.');

    // 5. Create appointment_presence_events table
    console.log('Creating appointment_presence_events table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.appointment_presence_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id UUID REFERENCES public.appointments(id) ON DELETE CASCADE,
        user_id UUID,
        role TEXT CHECK (role IN ('doctor', 'patient')),
        event_type TEXT CHECK (event_type IN ('joined', 'left')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Successfully created appointment_presence_events table.');

    // 6. Create diet_plans table if missing & reload PostgREST schema cache
    console.log('Creating diet_plans table and reloading PostgREST schema cache...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.diet_plans (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        appointment_id UUID UNIQUE REFERENCES public.appointments(id) ON DELETE CASCADE,
        patient_id UUID REFERENCES public.users(id) NOT NULL,
        doctor_id UUID REFERENCES public.users(id) NOT NULL,
        title TEXT NOT NULL,
        plan_details JSONB NOT NULL DEFAULT '{}'::jsonb,
        document_url TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_diet_plans_patient ON public.diet_plans (patient_id, created_at DESC);

      -- Force Supabase PostgREST API to refresh schema cache immediately
      NOTIFY pgrst, 'reload schema';
    `);
    console.log('Successfully created diet_plans table and reloaded PostgREST schema cache.');

  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await client.end();
  }
}

run();
