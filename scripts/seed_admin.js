require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function seedAdmin() {
  const email = 'contact.shebloom2026@gmail.com';
  const password = 'shebloom@2026';

  console.log(`Creating admin user: ${email}...`);

  try {
    // 1. Create user in auth.users via admin API
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'SheBloom Admin' }
    });

    if (authError) {
      if (authError.message.includes('already exists')) {
        console.log('Admin user already exists in auth.users.');
      } else {
        throw authError;
      }
    } else {
      console.log('Successfully created user in auth.users:', authData.user.id);
    }

    // Get the user id (either from creation or by fetching)
    let userId;
    if (authData?.user) {
      userId = authData.user.id;
    } else {
      // Find the user if they already existed
      const { data: usersData, error: fetchError } = await supabase.auth.admin.listUsers();
      if (fetchError) throw fetchError;
      const existingUser = usersData.users.find(u => u.email === email);
      if (!existingUser) throw new Error('Could not find existing user');
      userId = existingUser.id;
    }

    // 2. Ensure they exist in public.users with 'admin' role
    const { error: upsertError } = await supabase
      .from('users')
      .upsert({
        id: userId,
        email: email,
        full_name: 'SheBloom Admin',
        role: 'admin'
      }, { onConflict: 'id' });

    if (upsertError) {
      throw upsertError;
    }

    console.log('Successfully configured public.users row with admin role.');
    console.log('Admin seeding complete!');
    
  } catch (err) {
    console.error('Error seeding admin:', err);
    process.exit(1);
  }
}

seedAdmin();
