import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

export const chatRouter = Router();

export const AI_BOT_ID = '00000000-0000-0000-0000-0000000000a1';

/**
 * GET /api/chat/conversations
 * Returns all conversations for the current user.
 */
chatRouter.get('/conversations', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const roleField = req.userRole === 'doctor' ? 'doctor_id' : 'patient_id';

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

    // If requesting AI thread
    if (targetId === 'ai' || targetId === AI_BOT_ID) {
      let { data: aiConvo } = await supabaseAdmin
        .from('chat_conversations')
        .select('*')
        .eq('patient_id', req.userId)
        .eq('doctor_id', AI_BOT_ID)
        .maybeSingle();

      if (!aiConvo) {
        const { data: newConvo } = await supabaseAdmin
          .from('chat_conversations')
          .insert({
            patient_id: req.userId,
            doctor_id: AI_BOT_ID,
          })
          .select()
          .single();
        aiConvo = newConvo;
      }

      res.json({
        conversation: aiConvo,
        isAi: true,
        aiBotInfo: {
          id: AI_BOT_ID,
          full_name: 'AI Health Assistant',
          avatar_url: '/images/logo_icon.png',
        },
      });
      return;
    }

    // Resolve targetUserId for real doctor/patient
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

    const { data: doctorInfo } = await supabaseAdmin
      .from('doctors')
      .select('id')
      .eq('user_id', doctor_id_resolved)
      .maybeSingle();
    const actualDoctorTableId = doctorInfo?.id;

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
        res.status(403).json({ error: 'You must have a booking with Dr. Deepa Madhavan to access direct consultation chat.' });
        return;
      }
    }

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

/**
 * POST /api/chat/ai/message
 * Generates AI Health Assistant educational response and logs both prompt & reply to Postgres.
 */
/**
 * POST /api/chat/ai/message
 * Generates AI Health Assistant educational response. Accessible to both authenticated & guest users.
 */
chatRouter.post('/ai/message', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || typeof content !== 'string' || !content.trim()) {
      res.status(400).json({ error: 'Message content is required' });
      return;
    }

    // Try optional auth extraction from header if token present
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      try {
        const { data: { user } } = await supabaseAdmin.auth.getUser(token);
        if (user) userId = user.id;
      } catch (e) {
        // Guest user fallback
      }
    }

    // Generate dynamic AI response via Grok xAI API or Gemini API
    const aiText = await generateAiHealthResponse(content.trim());
    const finalAiContent = `${aiText}\n\n*Note: This response is for general educational purposes only and is not a substitute for a real medical consultation.*`;

    let userMsg = null;
    let aiMsg = null;
    let convoId = `guest-convo-${Date.now()}`;

    if (userId) {
      // Log to Postgres for authenticated users
      let { data: convo } = await supabaseAdmin
        .from('chat_conversations')
        .select('id')
        .eq('patient_id', userId)
        .eq('doctor_id', AI_BOT_ID)
        .maybeSingle();

      if (!convo) {
        const { data: newConvo } = await supabaseAdmin
          .from('chat_conversations')
          .insert({ patient_id: userId, doctor_id: AI_BOT_ID })
          .select('id')
          .single();
        convo = newConvo;
      }

      if (convo) {
        convoId = convo.id;
        const { data: uMsg } = await supabaseAdmin
          .from('chat_messages')
          .insert({ conversation_id: convo.id, sender_id: userId, content: content.trim() })
          .select()
          .single();
        userMsg = uMsg;

        const { data: aMsg } = await supabaseAdmin
          .from('chat_messages')
          .insert({ conversation_id: convo.id, sender_id: AI_BOT_ID, content: finalAiContent })
          .select()
          .single();
        aiMsg = aMsg;

        await supabaseAdmin
          .from('chat_conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('id', convo.id);
      }
    }

    if (!aiMsg) {
      aiMsg = {
        id: `ai-${Date.now()}`,
        conversation_id: convoId,
        sender_id: AI_BOT_ID,
        content: finalAiContent,
        created_at: new Date().toISOString(),
      };
    }

    res.json({
      userMessage: userMsg || { id: `u-${Date.now()}`, sender_id: 'user', content: content.trim(), created_at: new Date().toISOString() },
      aiMessage: aiMsg,
      conversationId: convoId,
    });
  } catch (err) {
    console.error('AI Message error:', err);
    res.status(500).json({ error: 'Failed to process AI message' });
  }
});

async function generateAiHealthResponse(question: string): Promise<string> {
  const xaiApiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  // System Prompt for Women's Health & Gynecological Persona
  const systemPrompt = `You are the SheBloom AI Health Assistant, a warm, highly empathetic, intelligent, and interactive women's health AI guide specializing in gynecology, menstrual cycle tracking, PCOS, PCOD, thyroid, and reproductive wellness.
Guidelines:
1. Provide interactive, engaging, supportive, and clear educational answers to the user's question.
2. DO NOT provide official medical diagnoses, DO NOT prescribe medication or specific drug dosages.
3. Encourage healthy lifestyle practices (pelvic yoga, seed cycling, hydration, stress management).
4. Use bullet points and clear, structured sections.
5. Conclude with a helpful follow-up tip or encouraging question to keep the conversation interactive.`;

  // 1. Try Grok (xAI API) if XAI_API_KEY / GROK_API_KEY is present
  if (xaiApiKey) {
    try {
      console.log('🤖 Invoking xAI Grok API...');
      const grokRes = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${xaiApiKey.trim()}`,
        },
        body: JSON.stringify({
          model: 'grok-2-latest',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: question },
          ],
          temperature: 0.7,
        }),
      });

      if (grokRes.ok) {
        const data = (await grokRes.json()) as any;
        const answer = data?.choices?.[0]?.message?.content;
        if (answer) {
          console.log('✅ xAI Grok API response generated successfully!');
          return answer;
        }
      } else {
        const errText = await grokRes.text();
        console.error('xAI Grok API error response:', grokRes.status, errText);
      }
    } catch (err) {
      console.error('xAI Grok API call exception:', err);
    }
  }

  // 2. Try Gemini API if GEMINI_API_KEY is present
  if (geminiApiKey) {
    try {
      console.log('🤖 Invoking Gemini API...');
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [{ parts: [{ text: question }] }]
        })
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          console.log('✅ Gemini API response generated successfully!');
          return text;
        }
      } else {
        const errText = await response.text();
        console.error('Gemini API error response:', response.status, errText);
      }
    } catch (err) {
      console.error('Gemini API call exception:', err);
    }
  }

  // 3. Dynamic Interactive Fallback Engine
  const q = question.toLowerCase();

  if (q.includes('discharge') || q.includes('white') || q.includes('fluid') || q.includes('wet')) {
    return `Vaginal discharge is a completely natural and vital function of reproductive health! Here is what your body might be telling you:

• **Egg-White & Stretchy**: Peak fertility window! Indicates ovulation is occurring.
• **Milky White & Creamy**: Normal in the follicular or luteal phase, helping to lubricate tissues.
• **Thick & Clumpy**: Could indicate a temporary yeast shift, especially if accompanied by itching.

💡 *Interactive Tip*: Are you currently tracking your cycle phase? Log your symptoms daily to spot patterns easily!`;
  }

  if (q.includes('pcos') || q.includes('pcod') || q.includes('cyst') || q.includes('delay') || q.includes('hair')) {
    return `Polycystic Ovary Syndrome (PCOS) involves hormonal & metabolic fluctuations. Here is how you can support your body holistically:

• **Insulin & Blood Glucose**: Pair complex carbs (quinoa, steel-cut oats) with protein & healthy fats to prevent glucose spikes.
• **Spearmint Tea**: Drinking 2 cups daily helps balance androgen levels naturally.
• **Pelvic Yoga**: Engaging in gentle hip-opening poses like Malasana improves ovarian blood flow.

💡 *Interactive Question*: Would you like to check out our targeted **Yoga for PCOS** classes or request a personalized **Diet Plan**?`;
  }

  if (q.includes('cramp') || q.includes('pain') || q.includes('back') || q.includes('bleed')) {
    return `Period cramps (dysmenorrhea) happen when prostaglandins cause uterine muscles to contract. Here are proven ways to soothe the discomfort:

• **Heat Therapy**: Apply a warm compress or heating pad to your lower abdomen for 15-20 minutes.
• **Warm Herbal Infusions**: Ginger, chamomile, or cinnamon tea help relax uterine smooth muscle.
• **Gentle Movement**: Child's Pose (Balasana) & Reclined Butterfly Pose relieve pelvic pressure.

💡 *Interactive Question*: How many days into your cycle are you? If pain persists, Dr. Deepa Madhav is available for a direct consultation!`;
  }

  return `Thank you for asking! I'm here to guide you through your health & wellness journey:

• **Hormonal & Cycle Harmony**: Fluctuations in period timing or symptoms are closely linked to sleep quality, stress levels, and daily nutrition.
• **Nurturing Habits**: Hydrating with 2.5L of warm water, practicing restorative pelvic yoga, and seed cycling provide strong baseline support.
• **Personalized Care**: For specific medical evaluations, you can book a direct video consultation with **Dr. Deepa Madhav**!

💡 *How else can I assist you today? Feel free to ask about period cramps, PCOS, diet tips, or yoga classes!*`;
}
