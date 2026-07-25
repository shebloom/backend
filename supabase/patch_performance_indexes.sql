-- ─── PERFORMANCE INDEXES FOR APPOINTMENTS & CONSULTATIONS ─────────────────────
-- Speeds up doctor & patient upcoming consultation queries

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_upcoming 
ON public.appointments (doctor_id, appointment_date, status);

CREATE INDEX IF NOT EXISTS idx_appointments_patient_upcoming 
ON public.appointments (patient_id, appointment_date, status);

CREATE INDEX IF NOT EXISTS idx_appointments_status_date 
ON public.appointments (status, appointment_date);

CREATE INDEX IF NOT EXISTS idx_diet_plans_patient_created 
ON public.diet_plans (patient_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wellness_sessions_active_created 
ON public.wellness_sessions (is_active, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wellness_programs_active_created 
ON public.wellness_programs (is_active, created_at DESC);
