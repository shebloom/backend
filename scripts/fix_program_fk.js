const { Client } = require('pg');

const connectionString = 'postgresql://postgres:Shebloom%402026@db.unmrwkifhdgtjupicmzv.supabase.co:5432/postgres';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function fixFk() {
  try {
    await client.connect();
    console.log('Altering program_enrollments FK constraint to ON DELETE CASCADE...');

    await client.query(`
      ALTER TABLE public.program_enrollments
      DROP CONSTRAINT IF EXISTS program_enrollments_program_id_fkey,
      ADD CONSTRAINT program_enrollments_program_id_fkey
        FOREIGN KEY (program_id) REFERENCES public.wellness_programs(id) ON DELETE CASCADE;
    `);

    console.log('Successfully updated program_enrollments FK to ON DELETE CASCADE!');
  } catch (err) {
    console.error('Fix FK error:', err);
  } finally {
    await client.end();
  }
}

fixFk();
