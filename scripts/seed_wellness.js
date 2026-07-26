const { Client } = require('pg');

const connectionString = 'postgresql://postgres:Shebloom%402026@db.unmrwkifhdgtjupicmzv.supabase.co:5432/postgres';

const client = new Client({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

const sqlScript = `
-- 1. Relax NOT NULL constraints, check constraints, and ensure required columns exist on wellness_programs and wellness_sessions
ALTER TABLE public.wellness_programs 
  ADD COLUMN IF NOT EXISTS condition TEXT,
  ADD COLUMN IF NOT EXISTS is_popular BOOLEAN DEFAULT false,
  ALTER COLUMN duration DROP NOT NULL,
  ALTER COLUMN category DROP NOT NULL,
  ALTER COLUMN image_url DROP NOT NULL;

ALTER TABLE public.wellness_sessions 
  ADD COLUMN IF NOT EXISTS program_id UUID REFERENCES public.wellness_programs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS order_index INTEGER,
  ALTER COLUMN subtitle DROP NOT NULL,
  ALTER COLUMN duration DROP NOT NULL,
  ALTER COLUMN type DROP NOT NULL,
  ALTER COLUMN thumbnail_url DROP NOT NULL,
  ALTER COLUMN category DROP NOT NULL;

ALTER TABLE public.wellness_sessions DROP CONSTRAINT IF EXISTS wellness_sessions_type_check;

-- 2. PCOS PROGRAM ------------------------------------------------
insert into wellness_programs (id, title, condition, description, category, duration, image_url, is_popular, created_at)
values (
  gen_random_uuid(),
  'Yoga for PCOS',
  'pcos',
  'A gentle, progressive yoga series designed to support hormonal balance, reduce insulin resistance, and ease common PCOS symptoms through consistent movement.',
  'PCOS Care',
  '4 Weeks',
  'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg',
  true,
  now()
);

do $$
declare
  pcos_id uuid;
begin
  select id into pcos_id from wellness_programs where condition = 'pcos' order by created_at desc limit 1;

  insert into wellness_sessions (id, program_id, title, subtitle, description, duration_minutes, duration, type, thumbnail_url, category, video_url, order_index, created_at)
  values
    (gen_random_uuid(), pcos_id, 'Foundations: Gentle Flow for PCOS', 'Introductory slow flow', 'An introductory slow flow focusing on breath and pelvic mobility, ideal for beginners.', 20, '20 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_pcos_session_1.mp4', 1, now()),
    (gen_random_uuid(), pcos_id, 'Hormone-Balancing Poses', 'Endocrine system support', 'Poses that support the endocrine system, including supported bridge and seated forward fold.', 25, '25 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_pcos_session_2.mp4', 2, now()),
    (gen_random_uuid(), pcos_id, 'Insulin-Sensitivity Flow', 'Metabolic circulation flow', 'A slightly more active sequence aimed at improving circulation and metabolic response.', 30, '30 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_pcos_session_3.mp4', 3, now()),
    (gen_random_uuid(), pcos_id, 'Stress & Cortisol Reset', 'Restorative stress reduction', 'Restorative practice to help lower stress hormones that can worsen PCOS symptoms.', 20, '20 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_pcos_session_4.mp4', 4, now()),
    (gen_random_uuid(), pcos_id, 'Full-Body PCOS Flow', 'Complete practice', 'A complete 35-minute practice combining all previous focus areas into one session.', 35, '35 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_pcos_session_5.mp4', 5, now());
end $$;

-- 3. THYROID PROGRAM -----------------------------------------------
insert into wellness_programs (id, title, condition, description, category, duration, image_url, is_popular, created_at)
values (
  gen_random_uuid(),
  'Yoga for Thyroid',
  'thyroid',
  'A supportive practice targeting the throat and neck region, circulation, and overall energy balance for those managing thyroid conditions.',
  'Thyroid Care',
  '3 Weeks',
  'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg',
  false,
  now()
);

do $$
declare
  thyroid_id uuid;
begin
  select id into thyroid_id from wellness_programs where condition = 'thyroid' order by created_at desc limit 1;

  insert into wellness_sessions (id, program_id, title, subtitle, description, duration_minutes, duration, type, thumbnail_url, category, video_url, order_index, created_at)
  values
    (gen_random_uuid(), thyroid_id, 'Throat & Neck Awareness Flow', 'Neck stretches and breathwork', 'Gentle neck stretches and breathwork to bring awareness to the thyroid region.', 15, '15 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_thyroid_session_1.mp4', 1, now()),
    (gen_random_uuid(), thyroid_id, 'Shoulder Stand Prep & Alternatives', 'Modified postures', 'Safe, modified approaches to poses traditionally linked with thyroid support.', 25, '25 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_thyroid_session_2.mp4', 2, now()),
    (gen_random_uuid(), thyroid_id, 'Energy & Metabolism Flow', 'Moderate-paced sequence', 'A moderate-paced sequence to support energy levels and metabolic function.', 30, '30 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_thyroid_session_3.mp4', 3, now()),
    (gen_random_uuid(), thyroid_id, 'Restorative Evening Practice', 'Sleep and recovery flow', 'A calming wind-down sequence to support sleep and recovery.', 20, '20 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_thyroid_session_4.mp4', 4, now());
end $$;

-- 4. GENERAL MENSTRUAL WELLNESS PROGRAM ------------------------------
insert into wellness_programs (id, title, condition, description, category, duration, image_url, is_popular, created_at)
values (
  gen_random_uuid(),
  'Yoga for General Menstrual Wellness',
  'general_menstrual_wellness',
  'A well-rounded practice for anyone looking to ease cramps, support a regular cycle, and build a sustainable yoga habit.',
  'Cycle Wellness',
  '3 Weeks',
  'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg',
  false,
  now()
);

do $$
declare
  general_id uuid;
begin
  select id into general_id from wellness_programs where condition = 'general_menstrual_wellness' order by created_at desc limit 1;

  insert into wellness_sessions (id, program_id, title, subtitle, description, duration_minutes, duration, type, thumbnail_url, category, video_url, order_index, created_at)
  values
    (gen_random_uuid(), general_id, 'Cramp Relief Flow', 'Easing menstrual cramping', 'Poses like child''s pose and reclined twists to ease menstrual cramping.', 15, '15 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_general_session_1.mp4', 1, now()),
    (gen_random_uuid(), general_id, 'Cycle Balance Flow', 'Regularity and cycle health', 'A moderate practice designed to support regularity and overall cycle health.', 25, '25 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_general_session_2.mp4', 2, now()),
    (gen_random_uuid(), general_id, 'Energizing Follicular Phase Flow', 'Follicular phase practice', 'A slightly more dynamic sequence suited for the follicular phase of the cycle.', 30, '30 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_general_session_3.mp4', 3, now()),
    (gen_random_uuid(), general_id, 'Gentle Luteal Phase Wind-Down', 'Luteal phase practice', 'A slower, grounding practice suited for the days leading up to your period.', 20, '20 min', 'self-paced', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg', 'Yoga', 'https://res.cloudinary.com/demo/video/upload/PLACEHOLDER_general_session_4.mp4', 4, now());
end $$;
`;

async function seed() {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database for wellness seed.');

    await client.query(sqlScript);
    console.log('Successfully executed wellness programs & sessions seed script!');

    const res = await client.query(`
      select p.title as program, s.title as session, s.duration_minutes, s.order_index
      from wellness_programs p
      join wellness_sessions s on s.program_id = p.id
      order by p.title, s.order_index;
    `);

    console.log('Verification query results:');
    console.table(res.rows);
  } catch (err) {
    console.error('Wellness seed error:', err);
  } finally {
    await client.end();
  }
}

seed();
