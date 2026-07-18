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

  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await client.end();
  }
}

run();
