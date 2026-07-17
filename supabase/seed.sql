-- Dummy data for testing. Note: these reference UUIDs that won't exist in auth.users,
-- so you might want to skip these unless you disable foreign keys or create test auth users first.

INSERT INTO public.wellness_programs (id, title, description, duration, category, image_url, is_popular) VALUES
('b2a8d3e9-a417-48f8-b807-6b4501a61c4d', 'PCOS Care Program', 'A comprehensive program to manage PCOS symptoms through diet, exercise, and lifestyle changes.', '8 Weeks', 'PCOS', 'https://images.pexels.com/photos/5473187/pexels-photo-5473187.jpeg?auto=compress&cs=tinysrgb&w=400', true),
('e9b46e3d-0d12-4cf0-84a9-83bc91e77033', 'Fertility Support Program', 'Evidence-based fertility support combining nutrition, yoga, and expert consultations.', '12 Weeks', 'Fertility', 'https://images.pexels.com/photos/3845454/pexels-photo-3845454.jpeg?auto=compress&cs=tinysrgb&w=400', false),
('6f147321-df8b-4a57-b089-c454e9bc3532', 'Preconception Nutrition', 'Optimize your nutrition before conception for a healthy pregnancy.', '6 Weeks', 'Pregnancy', 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg?auto=compress&cs=tinysrgb&w=400', false);

INSERT INTO public.wellness_sessions (id, title, subtitle, duration, type, scheduled_at, thumbnail_url, category) VALUES
('6b907c11-9a74-4b52-b13c-d38c62c2f6d5', 'Prenatal Yoga', 'For a healthy pregnancy', '45 min', 'live', NOW() + interval '1 day', 'https://images.pexels.com/photos/3822621/pexels-photo-3822621.jpeg?auto=compress&cs=tinysrgb&w=400', 'Yoga'),
('18d2d46e-1d37-4d9b-a012-70b749d68545', 'Yoga for PCOS', 'Balance hormones naturally', '40 min', 'live', NOW() + interval '2 hours', 'https://images.pexels.com/photos/4056723/pexels-photo-4056723.jpeg?auto=compress&cs=tinysrgb&w=400', 'Yoga'),
('afcd15cc-25dc-4277-a841-3b7c8ec17183', 'Morning Yoga Flow', 'Energize your day', '20 min', 'self-paced', NULL, 'https://images.pexels.com/photos/4834183/pexels-photo-4834183.jpeg?auto=compress&cs=tinysrgb&w=400', 'Yoga');

INSERT INTO public.articles (id, title, excerpt, read_time, image_url, category) VALUES
('1b80c352-ecde-4899-ad1f-361ff9db87ba', 'Understanding PCOS', 'What is PCOS, how it affects your cycle, and the most effective ways to manage symptoms naturally.', '5 min read', 'https://images.pexels.com/photos/7089394/pexels-photo-7089394.jpeg?auto=compress&cs=tinysrgb&w=400', 'PCOS'),
('0a905a5a-4b71-4608-8eec-715b3c58b97d', 'Nutrition Tips for Fertility', 'Key nutrients and foods that support reproductive health and improve your chances of conception.', '4 min read', 'https://images.pexels.com/photos/1640777/pexels-photo-1640777.jpeg?auto=compress&cs=tinysrgb&w=400', 'Fertility');

-- Doctors and users need to be created via the Auth flow or proper backend scripts to ensure they exist in auth.users
