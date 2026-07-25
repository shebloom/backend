/**
 * Shared Backend Constants
 */

// Video consultation join window duration (in minutes and milliseconds)
export const CONSULTATION_JOIN_WINDOW_MINUTES = 30;
export const CONSULTATION_JOIN_WINDOW_MS = CONSULTATION_JOIN_WINDOW_MINUTES * 60 * 1000;

/**
 * IST offset in minutes (+5:30 = 330 minutes).
 * Appointment dates/times are always stored and displayed in IST.
 * The backend server runs in UTC, so we must convert when comparing.
 */
export const IST_OFFSET_MINUTES = 330; // UTC+5:30

/**
 * Parse an appointment_date string ("YYYY-MM-DD") and slot_time string ("HH:MM" or "HH:MM:SS")
 * as an IST (UTC+5:30) local time and return the equivalent UTC Date object.
 *
 * This is the ONLY correct way to reconstruct a scheduled timestamp on the backend,
 * because:
 *   - slot_time is stored as the IST time the doctor/patient selected.
 *   - The server runs in UTC, so new Date(y, m-1, d, h, min) would create a UTC-local time,
 *     which is 5:30 hours off from the intended IST time.
 *
 * Example: slot_time "11:30" on 2025-07-25 in IST = 2025-07-25T06:00:00Z in UTC.
 */
export function parseAppointmentTimeAsIST(appointmentDate: string, slotTime: string): Date {
  const [y, m, d] = (appointmentDate || '').split('-').map(Number);
  const [h, min] = (slotTime || '').split(':').map(Number);

  // Build a UTC timestamp that represents the IST wall-clock time
  // IST = UTC + 330 minutes, so to get UTC from IST wall clock: UTC = IST_wall - 330 min
  const utcMs = Date.UTC(y, (m || 1) - 1, d || 1, h || 0, min || 0, 0, 0)
    - IST_OFFSET_MINUTES * 60 * 1000;

  return new Date(utcMs);
}
