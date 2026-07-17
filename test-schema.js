import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://unmrwkifhdgtjupicmzv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getTables() {
  const { data, error } = await supabase.rpc('get_tables_info'); // Wait, rpc might not exist.
  // Instead, let's query a known view if it exists, or just query common names.
  const tables = ['users', 'profiles', 'patients', 'doctors', 'appointments', 'health_records', 'cycle_logs'];
  
  for (const table of tables) {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (!error) {
      console.log(`Table exists: ${table}`);
    } else {
      console.log(`Table missing or error: ${table} - ${error.message}`);
    }
  }
}

getTables();
