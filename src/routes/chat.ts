import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const chatRouter = Router();

/**
 * GET /api/chat/conversations
 * Returns all conversations for the current user.
 */
chatRouter.get('/conversations', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const roleField = req.userRole === 'doctor' ? 'doctor_id' : 'patient_id';

    // Get distinct conversations from chat_messages
    const { data, error } = await supabaseAdmin
      .from('chat_conversations')
      .select('*, doctors(*, users!inner(full_name, avatar_url)), patients:users!chat_conversations_patient_id_fkey(full_name, avatar_url)')
      .eq(roleField, req.userId)
      .order('last_message_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch conversations' });
      return;
    }

    res.json({ conversations: data || [] });
  } catch (err) {
    console.error('Get conversations error:', err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

/**
 * GET /api/chat/messages/:conversationId
 * Returns messages for a specific conversation.
 */
chatRouter.get('/messages/:conversationId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('chat_messages')
      .select('*')
      .eq('conversation_id', req.params.conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch messages' });
      return;
    }

    res.json({ messages: data || [] });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * POST /api/chat/messages
 * Send a new message (with optional attachment).
 */
chatRouter.post('/messages', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { conversation_id, content, attachment_url } = req.body;

    if (!conversation_id || (!content && !attachment_url)) {
      res.status(400).json({ error: 'conversation_id and content or attachment are required' });
      return;
    }

    const { data, error } = await supabaseAdmin
      .from('chat_messages')
      .insert({
        conversation_id,
        sender_id: req.userId,
        content: content || null,
        attachment_url: attachment_url || null,
      })
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to send message' });
      return;
    }

    // Update conversation last_message_at
    await supabaseAdmin
      .from('chat_conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation_id);

    res.status(201).json({ message: data });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * POST /api/chat/conversations
 * Start a new conversation with a doctor/patient (or get existing one).
 */
chatRouter.post('/conversations', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { doctor_id, recipientId } = req.body;
    const targetId = recipientId || doctor_id;

    if (!targetId) {
      res.status(400).json({ error: 'recipientId or doctor_id is required' });
      return;
    }

    // Resolve targetUserId and doctorTableId
    // It could be doctors.id or users.id
    const { data: doctorRecord } = await supabaseAdmin
      .from('doctors')
      .select('user_id, id')
      .eq('id', targetId)
      .maybeSingle();

    let targetUserId = targetId;
    if (doctorRecord) {
      targetUserId = doctorRecord.user_id;
    }

    let patient_id_resolved = '';
    let doctor_id_resolved = '';

    if (req.userRole === 'doctor') {
      doctor_id_resolved = req.userId!;
      patient_id_resolved = targetUserId;
    } else {
      patient_id_resolved = req.userId!;
      doctor_id_resolved = targetUserId;
    }

    // Lookup the doctor table ID
    const { data: doctorInfo } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', doctor_id_resolved)
      .maybeSingle();
    const actualDoctorTableId = doctorInfo?.id;

    // Enforce booking check for patients
    if (req.userRole === 'patient') {
      if (!actualDoctorTableId) {
        res.status(404).json({ error: 'Doctor record not found' });
        return;
      }

      const { data: booking } = await supabaseAdmin
        .from('appointments')
        .select('id')
        .eq('patient_id', req.userId)
        .eq('doctor_id', actualDoctorTableId)
        .limit(1)
        .maybeSingle();

      if (!booking) {
        res.status(403).json({ error: 'You must have a booking with this doctor to access chat.' });
        return;
      }
    }

    // Check if conversation already exists
    const { data: existing } = await supabaseAdmin
      .from('chat_conversations')
      .select('*')
      .eq('patient_id', patient_id_resolved)
      .eq('doctor_id', doctor_id_resolved)
      .maybeSingle();

    if (existing) {
      res.json({ conversation: existing });
      return;
    }

    // Create new conversation
    const { data, error } = await supabaseAdmin
      .from('chat_conversations')
      .insert({
        patient_id: patient_id_resolved,
        doctor_id: doctor_id_resolved,
      })
      .select()
      .single();

    if (error) {
      console.error('Create conversation DB error:', error);
      res.status(500).json({ error: 'Failed to create conversation' });
      return;
    }

    res.status(201).json({ conversation: data });
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
});
