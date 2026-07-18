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

  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await client.end();
  }
}

run();
