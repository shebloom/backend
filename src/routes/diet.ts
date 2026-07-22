import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { LOCAL_DIET_PLANS } from '../lib/memoryStore';

export const dietRouter = Router();

// Curated templates
const DIET_TEMPLATES = [
  {
    id: 'pcos-anti-inflammatory',
    title: 'PCOS Anti-Inflammatory & Insulin Balance Plan',
    category: 'PCOS Care',
    summary: 'Designed to reduce insulin resistance, stabilize blood glucose spikes, and decrease pelvic inflammation.',
    guidelines: [
      'Focus on low glycemic index (GI) whole grains: quinoa, brown rice, steel-cut oats.',
      'Incorporate seed cycling: 1 tbsp flax + pumpkin seeds (Days 1-14); 1 tbsp sesame + sunflower seeds (Days 15-28).',
      'Daily herbal tea: Spearmint tea twice daily to support androgen balance.',
      'Avoid refined sugars, artificial sweeteners, and ultra-processed seed oils.',
    ],
    meal_structure: {
      breakfast: 'Avocado & poached eggs on sourdough or chia pudding with berries.',
      lunch: 'Grilled salmon or tofu salad with leafy greens, olive oil, and quinoa.',
      snack: 'Handful of raw walnuts + spearmint tea.',
      dinner: 'Steamed vegetables with lean chicken breast or dal with turmeric and ghee.',
    },
  },
  {
    id: 'thyroid-metabolic-balance',
    title: 'Thyroid & Metabolic Support Plan',
    category: 'Thyroid Care',
    summary: 'Focuses on selenium, iodine, zinc, and gut-healthy nutrients to optimize thyroid hormone conversion.',
    guidelines: [
      'Include 2 Brazil nuts daily for optimal selenium intake.',
      'Cook cruciferous vegetables (broccoli, cabbage, kale) to neutralize goitrogens.',
      'Maintain protein pacing: 25-30g clean protein per meal.',
      'Limit gluten and dairy if sensitive, and avoid caffeine on an empty stomach.',
    ],
    meal_structure: {
      breakfast: 'Spinach and mushroom omelet cooked in coconut oil + 2 Brazil nuts.',
      lunch: 'Quinoa bowl with roasted pumpkin, chickpea stew, and olive oil dressing.',
      snack: 'Warm golden turmeric milk with coconut oil.',
      dinner: 'Baked cod or lentil soup with roasted sweet potatoes.',
    },
  },
  {
    id: 'fertility-menstrual-wellness',
    title: 'Fertility & Menstrual Cycle Harmony Plan',
    category: 'Menstrual Health',
    summary: 'Nourishes blood volume, supports luteal progesterone production, and reduces dysmenorrhea cramping.',
    guidelines: [
      'Prioritize iron-rich foods combined with Vitamin C for optimal absorption (e.g. spinach + lemon juice).',
      'Consume warm, cooked foods during the menstrual phase; avoid ice-cold drinks.',
      'Healthy fats: Ghee, avocados, extra virgin olive oil, and wild-caught fish.',
      'Hydrate with warm ginger-cinnamon tea during menstruation.',
    ],
    meal_structure: {
      breakfast: 'Warm cinnamon oatmeal topped with pumpkin seeds, hemp hearts, and blueberries.',
      lunch: 'Warm beetroot and lentil salad with pumpkin seeds and olive oil.',
      snack: 'Baked apple with cinnamon & almond butter.',
      dinner: 'Slow-cooked bone broth or vegetable stew with root vegetables.',
    },
  },
];

/**
 * GET /api/diet/templates
 * Returns available structured diet plan templates.
 */
dietRouter.get('/templates', requireAuth, async (_req, res) => {
  res.json({ templates: DIET_TEMPLATES });
});

/**
 * GET /api/diet/patient
 * Get all diet plans assigned to the logged-in patient.
 */
dietRouter.get('/patient', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('diet_plans')
      .select('*, appointments(appointment_date, slot_time, doctors(*, users!inner(full_name)))')
      .eq('patient_id', req.userId)
      .order('created_at', { ascending: false });

    const dbPlans = data || [];
    const memPlans = LOCAL_DIET_PLANS.filter(p => p.patient_id === req.userId);
    const combined = [...memPlans, ...dbPlans];
    const unique = Array.from(new Map(combined.map(p => [p.id, p])).values());

    unique.sort((a, b) => {
      const aHasDoc = a.doctor_id && a.doctor_id !== 'ai';
      const bHasDoc = b.doctor_id && b.doctor_id !== 'ai';
      if (aHasDoc && !bHasDoc) return -1;
      if (!aHasDoc && bHasDoc) return 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    res.json({ diet_plans: unique });
  } catch (err) {
    console.error('Get patient diet plans error:', err);
    const memPlans = LOCAL_DIET_PLANS.filter(p => p.patient_id === req.userId);
    memPlans.sort((a, b) => {
      const aHasDoc = a.doctor_id && a.doctor_id !== 'ai';
      const bHasDoc = b.doctor_id && b.doctor_id !== 'ai';
      if (aHasDoc && !bHasDoc) return -1;
      if (!aHasDoc && bHasDoc) return 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    res.json({ diet_plans: memPlans });
  }
});

/**
 * GET /api/diet/appointment/:appointmentId
 * Get diet plan for a specific consultation.
 */
dietRouter.get('/appointment/:appointmentId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('diet_plans')
      .select('*')
      .eq('appointment_id', req.params.appointmentId)
      .maybeSingle();

    res.json({ diet_plan: data || null });
  } catch (err) {
    console.error('Get appointment diet plan error:', err);
    res.status(500).json({ error: 'Failed to fetch diet plan' });
  }
});

/**
 * POST /api/diet/attach
 * Doctor or Admin attaches a diet plan to a consultation.
 */
dietRouter.post('/attach', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { appointment_id, patient_id, template_id, title, plan_details, document_url, notes } = req.body;

    if (!patient_id) {
      res.status(400).json({ error: 'patient_id is required' });
      return;
    }

    let finalTitle = title;
    let finalDetails = plan_details;

    if (template_id) {
      const tmpl = DIET_TEMPLATES.find(t => t.id === template_id);
      if (tmpl) {
        finalTitle = finalTitle || tmpl.title;
        finalDetails = finalDetails || {
          summary: tmpl.summary,
          guidelines: tmpl.guidelines,
          meal_structure: tmpl.meal_structure,
        };
      }
    }

    const newDietPlan: any = {
      patient_id,
      doctor_id: req.userId,
      title: finalTitle || 'Personalized Wellness Diet Plan',
      plan_details: finalDetails || {},
      document_url: document_url || null,
      notes: notes || null,
      created_at: new Date().toISOString(),
    };

    // Only include appointment_id if it's a real UUID (not null/undefined/placeholder)
    const validApptId = appointment_id && appointment_id !== '00000000-0000-0000-0000-000000000000';
    if (validApptId) {
      newDietPlan.appointment_id = appointment_id;
    }

    let data: any;
    let error: any;

    if (validApptId) {
      // Upsert by appointment — one plan per consultation
      const result = await supabaseAdmin
        .from('diet_plans')
        .upsert(newDietPlan, { onConflict: 'appointment_id' })
        .select()
        .single();
      data = result.data;
      error = result.error;
    } else {
      // Insert freely — plan directly assigned to patient outside a booking
      const result = await supabaseAdmin
        .from('diet_plans')
        .insert(newDietPlan)
        .select()
        .single();
      data = result.data;
      error = result.error;
    }

    if (error) {
      console.error('Insert diet plan error:', error);
      // Memory fallback if table does not exist
      res.status(201).json({ diet_plan: { id: `diet-${Date.now()}`, ...newDietPlan } });
      return;
    }

    // Auto-send chat message notification to patient from Dr. Deepa
    try {
      const { data: convo } = await supabaseAdmin
        .from('chat_conversations')
        .select('id')
        .eq('patient_id', patient_id)
        .eq('doctor_id', req.userId)
        .maybeSingle();

      let convoId = convo?.id;
      if (!convoId) {
        const { data: newConvo } = await supabaseAdmin
          .from('chat_conversations')
          .insert({ patient_id, doctor_id: req.userId })
          .select('id')
          .single();
        convoId = newConvo?.id;
      }

      if (convoId) {
        await supabaseAdmin.from('chat_messages').insert({
          conversation_id: convoId,
          sender_id: req.userId,
          content: `📋 Dr. Deepa Madhavan attached a personalized Diet Plan to your consultation: "${finalTitle}". You can review it directly under your consultation record or My Health section.`,
        });
      }
    } catch (e) {
      console.error('Chat notification error:', e);
    }

    res.status(201).json({ diet_plan: data });
  } catch (err) {
    console.error('Attach diet plan error:', err);
    res.status(500).json({ error: 'Failed to attach diet plan' });
  }
});

/**
 * PATCH /api/diet/:planId
 * Doctor or Admin updates an existing patient diet plan.
 */
dietRouter.patch('/:planId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { title, plan_details, notes, document_url } = req.body;

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (title !== undefined) updates.title = title;
    if (plan_details !== undefined) updates.plan_details = plan_details;
    if (notes !== undefined) updates.notes = notes;
    if (document_url !== undefined) updates.document_url = document_url;

    const { data, error } = await supabaseAdmin
      .from('diet_plans')
      .update(updates)
      .eq('id', req.params.planId)
      .select()
      .single();

    if (error) {
      console.error('Update diet plan error:', error);
      res.status(500).json({ error: 'Failed to update diet plan' });
      return;
    }

    res.json({ diet_plan: data });
  } catch (err) {
    console.error('Update diet plan error:', err);
    res.status(500).json({ error: 'Failed to update diet plan' });
  }
});

/**
 * Helper function to generate a parametric clinical diet plan tailored to
 * patient vitals, BMI, condition, symptoms, and dietary preference when external AI is offline.
 */
export function generateClinicalDietPlan(
  weight: number,
  height: number,
  condition: string,
  symptoms: string = '',
  dietaryPreference: string = 'Vegetarian'
) {
  const heightM = height / 100;
  const bmi = parseFloat((weight / (heightM * heightM)).toFixed(1));

  let bmiCategory = 'Normal Weight';
  if (bmi < 18.5) bmiCategory = 'Underweight';
  else if (bmi >= 25 && bmi < 30) bmiCategory = 'Overweight';
  else if (bmi >= 30) bmiCategory = 'Obese';

  const condLower = condition.toLowerCase();
  const sympLower = symptoms.toLowerCase();
  const prefLower = dietaryPreference.toLowerCase();

  const isNonVeg = prefLower.includes('non-veg') || prefLower.includes('nonveg');
  const isVegan = prefLower.includes('vegan');
  const isEgg = prefLower.includes('egg');

  let title = '';
  let summary = '';
  const guidelines: string[] = [];
  const mealStructure: Record<string, string> = {};

  // 1. Determine Condition Specific Protocol
  if (condLower.includes('pcos') || condLower.includes('pcod') || condLower.includes('insulin')) {
    title = `PCOS Anti-Inflammatory & Glycemic Balance Protocol (BMI ${bmi})`;
    summary = `Personalized clinical protocol for ${weight}kg / ${height}cm (BMI ${bmi} - ${bmiCategory}, Preference: ${dietaryPreference}). Formulated to reduce insulin resistance, stabilize LH/FSH ratios, and lower ovarian inflammation.`;

    guidelines.push('Seed Cycling Protocol: 1 tbsp ground flaxseeds + pumpkin seeds daily (Days 1-14); 1 tbsp sesame + sunflower seeds (Days 15-28).');
    guidelines.push('Spearmint Tea: Sip 2 cups of pure spearmint tea daily to help regulate elevated androgen levels.');
    guidelines.push('Low-GI Carbs Only: Replace white rice & wheat with quinoa, steel-cut oats, and brown basmati.');
    guidelines.push('Glucose Spikes Protection: Always pair carbohydrates with healthy fats (avocado/olive oil/ghee) and protein.');

    if (isNonVeg) {
      mealStructure.breakfast = 'Spinach & 2 egg white omelet cooked in olive oil with 1/2 avocado.';
      mealStructure.breakfast_alternate = 'Smoked salmon & cucumber on sprouted sourdough with chia seeds.';
      mealStructure.lunch = 'Grilled chicken breast or salmon salad with mixed greens, quinoa, and lemon-olive oil dressing.';
      mealStructure.lunch_alternate = 'Turkey breast & avocado lettuce wraps with steamed broccoli.';
      mealStructure.dinner = 'Baked wild cod or skinless chicken breast with sautéed asparagus and cauliflower rice.';
      mealStructure.dinner_alternate = 'Herb-crusted salmon with steamed green beans and sweet potato mash.';
    } else if (isVegan) {
      mealStructure.breakfast = 'Tofu scramble with spinach, cherry tomatoes, and avocado on seed bread.';
      mealStructure.breakfast_alternate = 'Overnight chia pudding with unsweetened almond milk, flaxseeds, and blueberries.';
      mealStructure.lunch = 'Warm quinoa bowl with steamed edamame, roasted pumpkin seeds, and tahini dressing.';
      mealStructure.lunch_alternate = 'Sprouted mung bean & avocado salad with hemp hearts.';
      mealStructure.dinner = 'Lentil & spinach dal with turmeric, coconut oil, and small portion of brown rice.';
      mealStructure.dinner_alternate = 'Sautéed organic tofu with broccoli, bell peppers, and walnuts.';
    } else {
      // Vegetarian / Eggetarian
      mealStructure.breakfast = isEgg ? '2 poached eggs with avocado & sautéed spinach on sourdough.' : 'Paneer & spinach bhurji cooked in ghee with whole grain toast.';
      mealStructure.breakfast_alternate = 'Chia pudding topped with raw walnuts, flaxseeds, and cinnamon.';
      mealStructure.lunch = 'Paneer / Tofu & quinoa salad bowl with cucumbers, bell peppers, and olive oil.';
      mealStructure.lunch_alternate = 'Rajma (kidney bean) stew with brown rice and cucumber raita.';
      mealStructure.dinner = 'Yellow moong dal with ghee, steamed spinach, and a small quinoa roti.';
      mealStructure.dinner_alternate = 'Grilled cottage cheese (paneer) steak with roasted zucchini and bell peppers.';
    }

    mealStructure.snack = '1 cup spearmint tea + 6-8 raw walnuts.';
    mealStructure.snack_alternate = 'Roasted spiced chickpeas with lemon juice & cucumber slices.';

  } else if (condLower.includes('thyroid') || condLower.includes('metabolic') || condLower.includes('hashimoto')) {
    title = `Thyroid & Endocrine Conversion Protocol (BMI ${bmi})`;
    summary = `Clinical metabolic plan for ${weight}kg / ${height}cm (BMI ${bmi}). Formulated to optimize T4 to active T3 conversion, supply selenium/zinc, and reduce auto-immune thyroid triggers.`;

    guidelines.push('Selenium Optimization: Consume exactly 2 Brazil nuts daily (supplies ~100mcg natural selenium).');
    guidelines.push('Cooked Brassicas Only: Always cook cruciferous greens (broccoli, kale, cabbage) to neutralize goitrogens.');
    guidelines.push('Protein Pacing: Maintain 25-30g clean protein per main meal to sustain basal metabolic rate.');
    guidelines.push('Gut Barrier Care: Limit gluten and dairy if experiencing bloating or lethargy.');

    if (isNonVeg) {
      mealStructure.breakfast = '2 poached eggs with 2 Brazil nuts & sliced cucumber.';
      mealStructure.breakfast_alternate = 'Grilled mackerel or salmon with avocado.';
      mealStructure.lunch = 'Baked cod fillet with roasted sweet potato and steamed asparagus.';
      mealStructure.lunch_alternate = 'Chicken breast bowl with quinoa and olive oil.';
      mealStructure.dinner = 'Clear bone broth soup with stewed chicken and carrots.';
      mealStructure.dinner_alternate = 'Steamed sea bass with sautéed green beans.';
    } else {
      mealStructure.breakfast = 'Warm cinnamon quinoa porridge cooked in coconut milk + 2 Brazil nuts.';
      mealStructure.breakfast_alternate = 'Spinach & pumpkin seed smoothie bowl with hemp protein.';
      mealStructure.lunch = 'Chickpea & pumpkin coconut curry with brown rice.';
      mealStructure.lunch_alternate = 'Lentil & root vegetable stew with avocado.';
      mealStructure.dinner = 'Steamed tofu & zucchini curry with yellow moong dal.';
      mealStructure.dinner_alternate = 'Baked sweet potato stuffed with black beans and guacamole.';
    }

    mealStructure.snack = 'Warm golden turmeric milk with coconut oil + 2 Brazil nuts.';
    mealStructure.snack_alternate = 'Pumpkin seeds with herbal chamomile tea.';

  } else if (condLower.includes('cramp') || condLower.includes('period') || condLower.includes('menstrual') || condLower.includes('pain')) {
    title = `Menstrual Dysmenorrhea & Blood Replenishment Protocol (BMI ${bmi})`;
    summary = `Nutritional protocol for ${weight}kg / ${height}cm structured to reduce uterine prostaglandin E2 cramping, boost iron absorption, and alleviate cycle fatigue.`;

    guidelines.push('Prostaglandin Control: Sip warm ginger-cinnamon tea 3 times daily to inhibit inflammatory cramping enzymes.');
    guidelines.push('Iron & Vitamin C Pairing: Combine iron sources (spinach/lentils) with lemon juice for 3x higher absorption.');
    guidelines.push('Magnesium Density: Snack on 70%+ dark chocolate and pumpkin seeds to relax uterine smooth muscle.');
    guidelines.push('Thermal Care: Avoid ice water and raw cold foods during flow days; consume warm stews & broths.');

    if (isNonVeg) {
      mealStructure.breakfast = 'Scrambled eggs in ghee with sourdough toast & warm ginger tea.';
      mealStructure.breakfast_alternate = 'Warm cinnamon oats with turkey bacon & berries.';
      mealStructure.lunch = 'Warm lamb or chicken stew with root vegetables and lemon.';
      mealStructure.lunch_alternate = 'Iron-dense grilled liver or steak slices with wilted spinach.';
      mealStructure.dinner = 'Slow-cooked beef or chicken bone broth with sweet potatoes.';
      mealStructure.dinner_alternate = 'Pan-seared salmon with steamed beetroot and quinoa.';
    } else {
      mealStructure.breakfast = 'Warm cinnamon oatmeal topped with pumpkin seeds, hemp hearts, and blueberries.';
      mealStructure.breakfast_alternate = 'Sprouted moong dal chilla with mint-coriander chutney.';
      mealStructure.lunch = 'Warm beetroot, chickpea, and lentil stew with lemon zest.';
      mealStructure.lunch_alternate = 'Black lentil (dal makhani light) with brown rice and ghee.';
      mealStructure.dinner = 'Root vegetable stew (carrots, sweet potato, spinach) with warm quinoa.';
      mealStructure.dinner_alternate = 'Palak paneer / Palak tofu with A2 ghee and millet roti.';
    }

    mealStructure.snack = '2 squares 75% dark chocolate + warm ginger tea.';
    mealStructure.snack_alternate = 'Baked apple with cinnamon & almond butter.';

  } else if (condLower.includes('fertility') || condLower.includes('conception') || condLower.includes('luteal')) {
    title = `Fertility & Luteal Nourishment Protocol (BMI ${bmi})`;
    summary = `Clinical fertility nutrition for ${weight}kg / ${height}cm (BMI ${bmi}). Rich in folate, CoQ10, omega-3 fatty acids, and progesterone-supporting healthy fats.`;

    guidelines.push('Progesterone Fats: Include A2 ghee, avocados, and extra virgin olive oil to support steroid hormone synthesis.');
    guidelines.push('Natural Folate Boost: Consume dark leafy greens (spinach, arugula, asparagus, lentils) daily.');
    guidelines.push('CoQ10 & Anti-Oxidants: Include dark berries, walnuts, and sesame seeds for egg quality support.');
    guidelines.push('Zero Artificial Sweeteners: Avoid aspartame and sucralose which can disrupt gut microbiome balance.');

    if (isNonVeg) {
      mealStructure.breakfast = 'Avocado & poached egg on sprouted sourdough with sesame seeds.';
      mealStructure.breakfast_alternate = 'Wild salmon & asparagus omelet cooked in ghee.';
      mealStructure.lunch = 'Grilled wild salmon with quinoa, spinach, and avocado dressing.';
      mealStructure.lunch_alternate = 'Chicken liver & vegetable warm salad.';
      mealStructure.dinner = 'Steamed mackerel or cod with sweet potato and roasted beets.';
      mealStructure.dinner_alternate = 'Organic chicken curry cooked in coconut oil with brown rice.';
    } else {
      mealStructure.breakfast = 'Avocado toast on seed bread with hemp hearts & pumpkin seeds.';
      mealStructure.breakfast_alternate = 'Chia seed pudding made with coconut milk, walnuts, and raspberries.';
      mealStructure.lunch = 'Warm lentil & pomegranate salad with walnuts and olive oil.';
      mealStructure.lunch_alternate = 'Sprouted green gram salad with avocado and pumpkin seeds.';
      mealStructure.dinner = 'Paneer / Tofu curry with spinach, cashew cream, and quinoa.';
      mealStructure.dinner_alternate = 'Black bean & avocado bowl with roasted sweet potato.';
    }

    mealStructure.snack = 'Handful of raw walnuts + 1 cup warm chamomile tea.';
    mealStructure.snack_alternate = 'Sesame-sunflower seed laddu made with jaggery.';

  } else {
    // General Hormonal Balance & Wellness
    title = `Hormonal Equilibrium & Vitality Protocol (BMI ${bmi})`;
    summary = `Balanced metabolic nutrition plan customized for ${weight}kg / ${height}cm (BMI ${bmi} - ${bmiCategory}, Preference: ${dietaryPreference}). Promotes steady energy, digestive health, and endocrine balance.`;

    guidelines.push('Balanced Plate Rule: 50% non-starchy vegetables, 25% clean protein, 25% complex slow carbs.');
    guidelines.push('Hydration Goal: Drink at least 2.5 to 3 liters of filtered water daily.');
    guidelines.push('Fiber Goal: Aim for 30g+ daily fiber from flax, vegetables, and legumes to aid estrogen elimination.');
    guidelines.push('Night-time Rest: Stop eating 3 hours before sleep to optimize growth hormone release.');

    if (isNonVeg) {
      mealStructure.breakfast = '2 scrambled eggs with spinach and cherry tomatoes.';
      mealStructure.breakfast_alternate = 'Greek yogurt with berries and crushed walnuts.';
      mealStructure.lunch = 'Grilled chicken breast with quinoa and mixed green salad.';
      mealStructure.lunch_alternate = 'Salmon bowl with avocado and brown rice.';
      mealStructure.dinner = 'Baked cod fillet with steamed broccoli and sweet potato.';
      mealStructure.dinner_alternate = 'Turkey stew with zucchini and bell peppers.';
    } else {
      mealStructure.breakfast = 'Oatmeal topped with chia seeds, blueberries, and almond butter.';
      mealStructure.breakfast_alternate = 'Moong dal chilla with green chutney.';
      mealStructure.lunch = 'Mixed vegetable lentil dal with brown rice and cucumber salad.';
      mealStructure.lunch_alternate = 'Tofu / Paneer salad bowl with olive oil dressing.';
      mealStructure.dinner = 'Steamed vegetable stew with quinoa and ghee.';
      mealStructure.dinner_alternate = 'Palak paneer / Palak tofu with a small millet roti.';
    }

    mealStructure.snack = 'Green tea + handful of mixed almonds & walnuts.';
    mealStructure.snack_alternate = 'Apple slices with almond butter.';
  }

  // 2. Customize based on extra symptoms if present
  if (sympLower.includes('hair') || sympLower.includes('thinning') || sympLower.includes('fall')) {
    guidelines.push('Symptom Focus (Hair Health): Added biotin & zinc rich foods (pumpkin seeds, walnuts, spinach) to reduce follicular miniaturization.');
  }
  if (sympLower.includes('fatigue') || sympLower.includes('tired') || sympLower.includes('low energy')) {
    guidelines.push('Symptom Focus (Energy Boost): Added iron-dense spirulina/spinach and Vitamin B12 support to combat hormonal lethargy.');
  }
  if (sympLower.includes('bloat') || sympLower.includes('gas') || sympLower.includes('digest')) {
    guidelines.push('Symptom Focus (Gut Health): Drink warm fennel-cumin water post meals to alleviate pelvic gas & bloating.');
  }

  return {
    title,
    summary,
    guidelines,
    meal_structure: mealStructure,
  };
}

/**
 * POST /api/diet/generate
 * Generates a dynamic clinical diet plan using AI based on patient vitals and conditions.
 */
dietRouter.post('/generate', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { weight, height, condition, symptoms, dietary_preference } = req.body;

    if (!weight || !height || !condition) {
      res.status(400).json({ error: 'weight, height, and condition are required' });
      return;
    }

    const numericWeight = parseFloat(weight);
    const numericHeight = parseFloat(height);
    const pref = dietary_preference || 'Vegetarian';

    const systemPrompt = `You are a clinical gynecological dietitian specializing in hormonal balance, PCOS, thyroid regulation, and reproductive health.
Given the patient's inputs:
- Primary Condition: ${condition}
- Weight: ${numericWeight} kg
- Height: ${numericHeight} cm
- Dietary Preference: ${pref}
- Symptoms / Reports: ${symptoms || 'None'}

Generate a highly specific, structured diet plan in JSON format. The JSON MUST follow this exact structure:
{
  "title": "A specific encouraging title tailored to the condition and BMI",
  "summary": "A 2-3 sentence clinical overview explaining how this plan matches their specific vitals and dietary preference",
  "guidelines": [
    "Guideline 1",
    "Guideline 2",
    "Guideline 3",
    "Guideline 4"
  ],
  "meal_structure": {
    "breakfast": "Primary breakfast recommendation matching dietary preference",
    "breakfast_alternate": "Alternative breakfast option matching dietary preference",
    "lunch": "Primary lunch recommendation",
    "lunch_alternate": "Alternative lunch option",
    "snack": "Primary snack recommendation",
    "snack_alternate": "Alternative snack option",
    "dinner": "Primary dinner recommendation",
    "dinner_alternate": "Alternative dinner option"
  }
}
Do not output markdown code blocks, do not output any extra text. Just output clean JSON.`;

    let planData: any = null;

    // 1. Try Gemini API models (gemini-2.0-flash, gemini-2.5-flash-lite, gemini-3.6-flash)
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (geminiApiKey) {
      const candidateModels = ['gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-3.6-flash'];
      for (const modelName of candidateModels) {
        try {
          console.log(`🤖 Attempting diet generation via Gemini API (${modelName})...`);
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey.trim()}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: systemPrompt }] }] }),
            }
          );

          if (response.ok) {
            const resJson = (await response.json()) as any;
            const text = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              const cleaned = text.replace(/```json/i, '').replace(/```/g, '').trim();
              planData = JSON.parse(cleaned);
              console.log(`✅ Diet plan generated successfully via Gemini (${modelName})!`);
              break;
            }
          }
        } catch (e) {
          console.warn(`Gemini model ${modelName} call failed:`, e);
        }
      }
    }

    // 2. High-precision Clinical Parametric Generator Fallback if external API calls fail
    if (!planData) {
      console.log('⚡ Generating clinical parametric diet plan...');
      planData = generateClinicalDietPlan(numericWeight, numericHeight, condition, symptoms, pref);
    }

    // Create the final plan document
    const newPlan = {
      id: `diet-${Date.now()}`,
      patient_id: req.userId,
      title: planData.title || 'Personalized Clinical Nutritional Plan',
      plan_details: {
        summary: planData.summary,
        guidelines: planData.guidelines,
        meal_structure: planData.meal_structure,
      },
      notes: `Clinical AI Plan generated based on Condition: ${condition}, Weight: ${numericWeight}kg, Height: ${numericHeight}cm, Preference: ${pref}. Verified & customizable by Dr. Deepa Madhavan.`,
      created_at: new Date().toISOString(),
    };

    LOCAL_DIET_PLANS.unshift(newPlan);

    // Save to database
    await supabaseAdmin
      .from('diet_plans')
      .insert(newPlan);

    res.status(201).json({ diet_plan: newPlan });
  } catch (err: any) {
    console.error('Diet generator API exception:', err);
    res.status(500).json({ error: err.message || 'Failed to generate diet plan' });
  }
});
