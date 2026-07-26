const { Client } = require('pg');

const connectionString = 'postgresql://postgres:Shebloom%402026@db.unmrwkifhdgtjupicmzv.supabase.co:5432/postgres';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function inspectForeignKeys() {
  try {
    await client.connect();
    console.log('--- INSPECTING FOREIGN KEYS FOR wellness_programs ---');

    const fkRes = await client.query(`
      SELECT
        tc.table_schema, 
        tc.constraint_name, 
        tc.table_name, 
        kcu.column_name, 
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.delete_rule
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE ccu.table_name = 'wellness_programs';
    `);

    console.table(fkRes.rows);

  } catch (err) {
    console.error('FK inspect error:', err);
  } finally {
    await client.end();
  }
}

inspectForeignKeys();
