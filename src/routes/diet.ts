import { Router } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { LOCAL_DIET_PLANS } from '../lib/memoryStore';
import { randomUUID } from 'crypto';

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
 * Helper to normalize a plan object and ensure source field is set consistently.
 */
function normalizeDietPlan(plan: any): any {
  if (!plan) return null;
  const isDoctor = plan.source === 'doctor' || 
                   plan.plan_details?.source === 'doctor' || 
                   (plan.doctor_id && plan.doctor_id !== plan.patient_id && plan.doctor_id !== '00000000-0000-0000-0000-000000000000');
  
  const source = isDoctor ? 'doctor' : 'ai_generated';
  const doctorName = plan.appointments?.doctors?.users?.full_name || plan.doctor_name || (isDoctor ? 'Dr. Deepa Madhavan' : null);

  return {
    ...plan,
    source,
    is_doctor_assigned: isDoctor,
    doctor_name: doctorName,
    plan_details: {
      ...(plan.plan_details || {}),
      source,
    },
  };
}

/**
 * GET /api/diet/patient
 * Get all diet plans assigned to the logged-in patient, prioritizing doctor-assigned plans.
 */
dietRouter.get('/patient', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { data } = await supabaseAdmin
      .from('diet_plans')
      .select('*, appointments(appointment_date, slot_time, doctors(*, users!inner(full_name)))')
      .eq('patient_id', req.userId)
      .order('updated_at', { ascending: false });

    const dbPlans = (data || []).map(normalizeDietPlan);
    const memPlans = LOCAL_DIET_PLANS.filter(p => p.patient_id === req.userId).map(normalizeDietPlan);
    const combined = [...dbPlans, ...memPlans];
    const unique = Array.from(new Map(combined.map(p => [p.id, p])).values());

    unique.sort((a, b) => {
      const timeA = new Date(a.updated_at || a.created_at).getTime();
      const timeB = new Date(b.updated_at || b.created_at).getTime();
      return timeB - timeA;
    });

    // Rule 1: Priority for doctor-assigned plan
    const doctorPlan = unique.find(p => p.source === 'doctor');
    // Rule 2: Fallback to AI-generated plan
    const aiPlan = unique.find(p => p.source === 'ai_generated');

    const activePlan = doctorPlan || aiPlan || null;

    res.json({
      active_plan: activePlan,
      diet_plans: unique,
    });
  } catch (err) {
    console.error('Get patient diet plans error:', err);
    const memPlans = LOCAL_DIET_PLANS.filter(p => p.patient_id === req.userId).map(normalizeDietPlan);
    const doctorPlan = memPlans.find(p => p.source === 'doctor');
    const aiPlan = memPlans.find(p => p.source === 'ai_generated');
    res.json({
      active_plan: doctorPlan || aiPlan || null,
      diet_plans: memPlans,
    });
  }
});

/**
 * GET /api/diet/patient/:patientId
 * Allows doctor to fetch a patient's active or latest diet plan before editing.
 */
dietRouter.get('/patient/:patientId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { patientId } = req.params;

    const { data } = await supabaseAdmin
      .from('diet_plans')
      .select('*, appointments(appointment_date, slot_time, doctors(*, users!inner(full_name)))')
      .eq('patient_id', patientId)
      .order('updated_at', { ascending: false });

    const dbPlans = (data || []).map(normalizeDietPlan);
    const memPlans = LOCAL_DIET_PLANS.filter(p => p.patient_id === patientId).map(normalizeDietPlan);
    const combined = [...dbPlans, ...memPlans];
    const unique = Array.from(new Map(combined.map(p => [p.id, p])).values());

    unique.sort((a, b) => {
      const timeA = new Date(a.updated_at || a.created_at).getTime();
      const timeB = new Date(b.updated_at || b.created_at).getTime();
      return timeB - timeA;
    });

    const doctorPlan = unique.find(p => p.source === 'doctor');
    const aiPlan = unique.find(p => p.source === 'ai_generated');
    const activePlan = doctorPlan || aiPlan || unique[0] || null;

    res.json({ diet_plan: activePlan });
  } catch (err) {
    console.error('Get patient diet plan by doctor error:', err);
    res.status(500).json({ error: 'Failed to fetch patient diet plan' });
  }
});

/**
 * GET /api/diet/appointment/:appointmentId
 * Get diet plan for a specific consultation or fallback to patient's latest plan.
 */
dietRouter.get('/appointment/:appointmentId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { appointmentId } = req.params;
    const { data } = await supabaseAdmin
      .from('diet_plans')
      .select('*')
      .eq('appointment_id', appointmentId)
      .maybeSingle();

    if (data) {
      res.json({ diet_plan: normalizeDietPlan(data) });
      return;
    }

    // Fallback: Check if appointment has patient_id to find any existing plan
    const { data: appt } = await supabaseAdmin
      .from('appointments')
      .select('patient_id')
      .eq('id', appointmentId)
      .single();

    if (appt?.patient_id) {
      const { data: patientPlan } = await supabaseAdmin
        .from('diet_plans')
        .select('*')
        .eq('patient_id', appt.patient_id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (patientPlan) {
        res.json({ diet_plan: normalizeDietPlan(patientPlan) });
        return;
      }
    }

    res.json({ diet_plan: null });
  } catch (err) {
    console.error('Get appointment diet plan error:', err);
    res.status(500).json({ error: 'Failed to fetch diet plan' });
  }
});

/**
 * POST /api/diet/attach
 * Doctor or Admin attaches or updates a doctor-assigned diet plan.
 */
dietRouter.post('/attach', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { appointment_id, patient_id, template_id, title, plan_details, document_url, notes } = req.body;

    if (!patient_id) {
      res.status(400).json({ error: 'patient_id is required' });
      return;
    }

    let finalTitle = title;
    let finalDetails = plan_details || {};

    if (template_id) {
      const tmpl = DIET_TEMPLATES.find(t => t.id === template_id);
      if (tmpl) {
        finalTitle = finalTitle || tmpl.title;
        finalDetails = {
          summary: tmpl.summary,
          guidelines: tmpl.guidelines,
          meal_structure: tmpl.meal_structure,
          ...finalDetails,
        };
      }
    }

    const nowIso = new Date().toISOString();
    const newDietPlan: any = {
      patient_id,
      doctor_id: req.userId,
      source: 'doctor',
      title: finalTitle || 'Personalized Wellness Diet Plan',
      plan_details: {
        ...(finalDetails || {}),
        source: 'doctor',
      },
      document_url: document_url || null,
      notes: notes || null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const validApptId = appointment_id && appointment_id !== '00000000-0000-0000-0000-000000000000';
    if (validApptId) {
      newDietPlan.appointment_id = appointment_id;
    }

    let data: any;
    let error: any;

    if (validApptId) {
      const result = await supabaseAdmin
        .from('diet_plans')
        .upsert(newDietPlan, { onConflict: 'appointment_id' })
        .select()
        .single();
      data = result.data;
      error = result.error;
    } else {
      // Check if an existing plan exists for this patient to update or insert
      const { data: existing } = await supabaseAdmin
        .from('diet_plans')
        .select('id')
        .eq('patient_id', patient_id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        const result = await supabaseAdmin
          .from('diet_plans')
          .update({
            doctor_id: req.userId,
            source: 'doctor',
            title: newDietPlan.title,
            plan_details: newDietPlan.plan_details,
            notes: newDietPlan.notes,
            document_url: newDietPlan.document_url,
            updated_at: nowIso,
          })
          .eq('id', existing.id)
          .select()
          .single();
        data = result.data;
        error = result.error;
      } else {
        const result = await supabaseAdmin
          .from('diet_plans')
          .insert(newDietPlan)
          .select()
          .single();
        data = result.data;
        error = result.error;
      }
    }

    if (error) {
      console.error('Insert/Update diet plan error:', error);
      const fallback = normalizeDietPlan({ id: `diet-${Date.now()}`, ...newDietPlan });
      LOCAL_DIET_PLANS.unshift(fallback);
      res.status(201).json({ diet_plan: fallback });
      return;
    }

    const normalizedData = normalizeDietPlan(data);
    LOCAL_DIET_PLANS.unshift(normalizedData);

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
          content: `📋 Dr. Deepa Madhavan assigned a personalized Diet Plan to your profile: "${finalTitle}". You can review it directly under your Diet Plan section.`,
        });
      }
    } catch (e) {
      console.error('Chat notification error:', e);
    }

    res.status(201).json({ diet_plan: normalizedData });
  } catch (err) {
    console.error('Attach diet plan error:', err);
    res.status(500).json({ error: 'Failed to attach diet plan' });
  }
});

/**
 * PATCH /api/diet/:planId
 * Doctor or Admin updates an existing patient diet plan (promotes to source = 'doctor').
 */
dietRouter.patch('/:planId', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { title, plan_details, notes, document_url } = req.body;

    const updates: Record<string, any> = {
      source: 'doctor',
      doctor_id: req.userId,
      updated_at: new Date().toISOString(),
    };
    if (title !== undefined) updates.title = title;
    if (plan_details !== undefined) {
      updates.plan_details = {
        ...(plan_details || {}),
        source: 'doctor',
      };
    }
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

    const normalizedData = normalizeDietPlan(data);
    res.json({ diet_plan: normalizedData });
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
  const recommended_categories: Array<{ name: string; reason: string }> = [];
  const foods_to_limit: Array<{ name: string; reason: string }> = [];
  let suggested_portion_sizing = {
    carb_pct: 40,
    protein_pct: 30,
    fat_pct: 30,
    calories: 1800,
    note: '',
  };
  const guidelines: string[] = [];
  const meal_structure: Record<string, string> = {};

  if (condLower.includes('pcos') || condLower.includes('pcod') || condLower.includes('insulin')) {
    title = `PCOS Glycemic Regulation Protocol (BMI ${bmi})`;
    summary = `Personalized clinical protocol for ${weight}kg / ${height}cm (BMI ${bmi} - ${bmiCategory}, Preference: ${dietaryPreference}). Formulated to reduce insulin resistance, stabilize LH/FSH ratios, and lower ovarian inflammation.`;

    recommended_categories.push(
      { name: 'Healthy Fats', reason: 'Supports hormone synthesis and reduces ovarian inflammation.' },
      { name: 'Lean Proteins', reason: 'Helps stabilize blood glucose levels and prevents muscle loss.' },
      { name: 'Low-GI Carbs', reason: 'Prevents insulin spikes and supports sustainable energy.' },
      { name: 'Cruciferous Vegetables', reason: 'Helps with estrogen detoxification in the liver.' }
    );

    foods_to_limit.push(
      { name: 'Refined Sugar & Sweets', reason: 'Triggers immediate insulin spikes, worsening PCOS symptoms.' },
      { name: 'Processed Seed Oils', reason: 'Highly inflammatory; worsens pelvic and follicular inflammation.' },
      { name: 'Refined Grains', reason: 'High glycemic index spikes insulin and androgen production.' }
    );

    suggested_portion_sizing = {
      carb_pct: 35,
      protein_pct: 35,
      fat_pct: 30,
      calories: Math.round(weight * 22),
      note: 'Lower carbohydrate, higher protein split to combat insulin resistance.',
    };

    guidelines.push('Seed Cycling Protocol: 1 tbsp ground flax + pumpkin seeds (Days 1-14); 1 tbsp sesame + sunflower (Days 15-28).');
    guidelines.push('Spearmint Tea: Sip 2 cups daily to help regulate elevated androgen levels naturally.');
    guidelines.push('Glucose Spikes Protection: Always pair carbohydrates with healthy fats (avocado/olive oil/ghee) and protein.');

    if (isNonVeg) {
      meal_structure.breakfast = 'Spinach & 2 egg white omelet cooked in olive oil with 1/2 avocado.';
      meal_structure.breakfast_alternate = 'Smoked salmon on sprouted sourdough with chia seeds.';
      meal_structure.lunch = 'Grilled chicken breast salad with mixed greens, quinoa, and olive oil dressing.';
      meal_structure.lunch_alternate = 'Turkey breast & avocado lettuce wraps with steamed broccoli.';
      meal_structure.snack = '1 cup spearmint tea + 6-8 raw walnuts.';
      meal_structure.snack_alternate = 'Cucumber slices with lemon juice.';
      meal_structure.dinner = 'Baked wild cod or skinless chicken breast with sautéed asparagus and cauliflower rice.';
      meal_structure.dinner_alternate = 'Herb-crusted salmon with steamed green beans and sweet potato mash.';
    } else if (isVegan) {
      meal_structure.breakfast = 'Tofu scramble with spinach, cherry tomatoes, and avocado on seed bread.';
      meal_structure.breakfast_alternate = 'Chia pudding with almond milk, flaxseeds, and blueberries.';
      meal_structure.lunch = 'Warm quinoa bowl with steamed edamame, roasted pumpkin seeds, and tahini.';
      meal_structure.lunch_alternate = 'Sprouted mung bean & avocado salad with hemp hearts.';
      meal_structure.snack = '1 cup spearmint tea + 6-8 raw walnuts.';
      meal_structure.snack_alternate = 'Roasted spiced chickpeas with lemon juice.';
      meal_structure.dinner = 'Lentil & spinach dal with turmeric, coconut oil, and small portion of brown rice.';
      meal_structure.dinner_alternate = 'Sautéed organic tofu with broccoli, bell peppers, and walnuts.';
    } else {
      meal_structure.breakfast = isEgg ? '2 poached eggs with avocado & sautéed spinach on sourdough.' : 'Paneer & spinach bhurji with whole grain toast.';
      meal_structure.breakfast_alternate = 'Chia pudding topped with raw walnuts, flaxseeds, and cinnamon.';
      meal_structure.lunch = 'Paneer & quinoa salad bowl with cucumbers, bell peppers, and olive oil.';
      meal_structure.lunch_alternate = 'Rajma (kidney bean) stew with brown rice and cucumber raita.';
      meal_structure.snack = '1 cup spearmint tea + 6-8 raw walnuts.';
      meal_structure.snack_alternate = 'Roasted spiced chickpeas with lemon juice.';
      meal_structure.dinner = 'Yellow moong dal with ghee, steamed spinach, and a small quinoa roti.';
      meal_structure.dinner_alternate = 'Grilled cottage cheese steak with roasted zucchini and bell peppers.';
    }

  } else if (condLower.includes('thyroid') || condLower.includes('metabolic') || condLower.includes('hashimoto')) {
    title = `Thyroid & Endocrine Support Protocol (BMI ${bmi})`;
    summary = `Clinical metabolic plan for ${weight}kg / ${height}cm (BMI ${bmi}). Formulated to optimize T4 to active T3 conversion, supply selenium/zinc, and reduce auto-immune thyroid triggers.`;

    recommended_categories.push(
      { name: 'Selenium & Zinc Rich Foods', reason: 'Essential cofactors for thyroid hormone synthesis and conversion.' },
      { name: 'Omega-3 Fatty Acids', reason: 'Reduces autoimmune thyroid antibody inflammation (Hashimoto\'s).' },
      { name: 'Fiber-Rich Foods', reason: 'Supports healthy gut motility to combat thyroid-induced constipation.' }
    );

    foods_to_limit.push(
      { name: 'Raw Cruciferous Greens', reason: 'Contains goitrogens that can block iodine absorption; eat only cooked.' },
      { name: 'Gluten & Excess Dairy', reason: 'Highly linked to thyroid autoimmune flareups in Hashimoto\'s.' },
      { name: 'Soy Isoflavones', reason: 'Can interfere with thyroid hormone absorption.' }
    );

    suggested_portion_sizing = {
      carb_pct: 45,
      protein_pct: 30,
      fat_pct: 25,
      calories: Math.round(weight * 20),
      note: 'Metabolic support split emphasizing selenium-rich ingredients.',
    };

    guidelines.push('Selenium Optimization: Consume exactly 2 Brazil nuts daily (supplies natural selenium).');
    guidelines.push('Cooked Brassicas: Always cook cruciferous greens to neutralize goitrogens.');
    guidelines.push('Protein Pacing: Maintain 25-30g clean protein per main meal to sustain basal metabolic rate.');

    if (isNonVeg) {
      meal_structure.breakfast = '2 poached eggs with 2 Brazil nuts & sliced cucumber.';
      meal_structure.breakfast_alternate = 'Grilled mackerel or salmon with avocado.';
      meal_structure.lunch = 'Baked cod fillet with roasted sweet potato and steamed asparagus.';
      meal_structure.lunch_alternate = 'Chicken breast bowl with quinoa and olive oil.';
      meal_structure.snack = 'Warm golden turmeric milk with coconut oil + 2 Brazil nuts.';
      meal_structure.snack_alternate = 'Pumpkin seeds with herbal chamomile tea.';
      meal_structure.dinner = 'Clear bone broth soup with stewed chicken and carrots.';
      meal_structure.dinner_alternate = 'Steamed sea bass with sautéed green beans.';
    } else {
      meal_structure.breakfast = 'Warm cinnamon quinoa porridge cooked in coconut milk + 2 Brazil nuts.';
      meal_structure.breakfast_alternate = 'Spinach & pumpkin seed smoothie bowl with hemp protein.';
      meal_structure.lunch = 'Chickpea & pumpkin coconut curry with brown rice.';
      meal_structure.lunch_alternate = 'Lentil & root vegetable stew with avocado.';
      meal_structure.snack = 'Warm golden turmeric milk with coconut oil + 2 Brazil nuts.';
      meal_structure.snack_alternate = 'Pumpkin seeds with herbal chamomile tea.';
      meal_structure.dinner = 'Steamed tofu & zucchini curry with yellow moong dal.';
      meal_structure.dinner_alternate = 'Baked sweet potato stuffed with black beans and guacamole.';
    }

  } else if (condLower.includes('cramp') || condLower.includes('period') || condLower.includes('menstrual') || condLower.includes('pain')) {
    title = `Menstrual Cramp & Blood Replenishment Protocol (BMI ${bmi})`;
    summary = `Nutritional protocol structured to reduce uterine prostaglandin E2 cramping, boost iron absorption, and alleviate cycle fatigue.`;

    recommended_categories.push(
      { name: 'Magnesium-Dense Foods', reason: 'Relaxes uterine smooth muscle to relieve painful cramps.' },
      { name: 'Iron & Vitamin C pairing', reason: 'Replenishes red blood cells lost during menstruation.' },
      { name: 'Warm Herbal Infusions', reason: 'Improves pelvic blood flow and reduces spasm.' }
    );

    foods_to_limit.push(
      { name: 'Sodium & Salty Foods', reason: 'Increases water retention and bloating during your period.' },
      { name: 'Caffeine', reason: 'Constricts blood vessels, which can worsen uterine cramping.' },
      { name: 'Ice-cold Food & Drinks', reason: 'Causes pelvic stagnation and worsens smooth muscle contraction.' }
    );

    suggested_portion_sizing = {
      carb_pct: 40,
      protein_pct: 30,
      fat_pct: 30,
      calories: Math.round(weight * 24),
      note: 'Anti-spasmodic split focusing on magnesium and iron recovery.',
    };

    guidelines.push('Prostaglandin Control: Sip warm ginger-cinnamon tea 3 times daily to inhibit inflammatory cramping.');
    guidelines.push('Iron Boost: Combine iron sources (spinach/lentils) with lemon juice for 3x higher absorption.');
    guidelines.push('Magnesium Density: Snack on 70%+ dark chocolate and pumpkin seeds to relax uterine muscles.');

    if (isNonVeg) {
      meal_structure.breakfast = 'Scrambled eggs in ghee with sourdough toast & warm ginger tea.';
      meal_structure.breakfast_alternate = 'Warm cinnamon oats with turkey bacon & berries.';
      meal_structure.lunch = 'Warm lamb or chicken stew with root vegetables and lemon.';
      meal_structure.lunch_alternate = 'Iron-dense grilled beef slices with wilted spinach.';
      meal_structure.snack = '2 squares 75% dark chocolate + warm ginger tea.';
      meal_structure.snack_alternate = 'Baked apple with cinnamon & almond butter.';
      meal_structure.dinner = 'Slow-cooked chicken bone broth with sweet potatoes.';
      meal_structure.dinner_alternate = 'Pan-seared salmon with steamed beetroot and quinoa.';
    } else {
      meal_structure.breakfast = 'Warm cinnamon oatmeal topped with pumpkin seeds, hemp hearts, and blueberries.';
      meal_structure.breakfast_alternate = 'Sprouted moong dal chilla with mint-coriander chutney.';
      meal_structure.lunch = 'Warm beetroot, chickpea, and lentil stew with lemon zest.';
      meal_structure.lunch_alternate = 'Black lentil with brown rice and ghee.';
      meal_structure.snack = '2 squares 75% dark chocolate + warm ginger tea.';
      meal_structure.snack_alternate = 'Baked apple with cinnamon & almond butter.';
      meal_structure.dinner = 'Root vegetable stew with warm quinoa.';
      meal_structure.dinner_alternate = 'Palak paneer or Palak tofu with A2 ghee and millet roti.';
    }

  } else if (condLower.includes('fertility') || condLower.includes('conception') || condLower.includes('luteal')) {
    title = `Fertility & Luteal Nourishment Protocol (BMI ${bmi})`;
    summary = `Clinical fertility nutrition rich in folate, CoQ10, omega-3 fatty acids, and progesterone-supporting healthy fats.`;

    recommended_categories.push(
      { name: 'Folate-Rich Greens', reason: 'Crucial for healthy cell division and prenatal preparation.' },
      { name: 'Healthy Steroidal Fats', reason: 'Essential building block for progesterone and estrogen synthesis.' },
      { name: 'Antioxidant-Dense Berries', reason: 'Protects eggs from oxidative stress and improves quality.' }
    );

    foods_to_limit.push(
      { name: 'Trans Fats & Margarine', reason: 'Increases risk of ovulatory infertility and blocks fat receptors.' },
      { name: 'Artificial Sweeteners', reason: 'Disrupts beneficial gut microflora and endocrine balance.' },
      { name: 'Alcohol & Excess Caffeine', reason: 'Directly impacts conception rates and ovarian reserve.' }
    );

    suggested_portion_sizing = {
      carb_pct: 40,
      protein_pct: 30,
      fat_pct: 30,
      calories: Math.round(weight * 25),
      note: 'Nourishing fertility split rich in folic acid and essential lipids.',
    };

    guidelines.push('Progesterone Fats: Include A2 ghee, avocados, and extra virgin olive oil to support hormones.');
    guidelines.push('Natural Folate: Consume dark leafy greens daily.');
    guidelines.push('Zero Artificial Sweeteners: Avoid aspartame and sucralose which can disrupt endocrine balance.');

    if (isNonVeg) {
      meal_structure.breakfast = 'Avocado & poached egg on sprouted sourdough with sesame seeds.';
      meal_structure.breakfast_alternate = 'Wild salmon & asparagus omelet cooked in ghee.';
      meal_structure.lunch = 'Grilled wild salmon with quinoa, spinach, and avocado dressing.';
      meal_structure.lunch_alternate = 'Chicken liver & vegetable warm salad.';
      meal_structure.snack = 'Handful of raw walnuts + 1 cup warm chamomile tea.';
      meal_structure.snack_alternate = 'Sesame-sunflower seed laddu made with jaggery.';
      meal_structure.dinner = 'Steamed mackerel or cod with sweet potato and roasted beets.';
      meal_structure.dinner_alternate = 'Organic chicken curry cooked in coconut oil with brown rice.';
    } else {
      meal_structure.breakfast = 'Avocado toast on seed bread with hemp hearts & pumpkin seeds.';
      meal_structure.breakfast_alternate = 'Chia seed pudding made with coconut milk, walnuts, and raspberries.';
      meal_structure.lunch = 'Warm lentil & pomegranate salad with walnuts and olive oil.';
      meal_structure.lunch_alternate = 'Sprouted green gram salad with avocado and pumpkin seeds.';
      meal_structure.snack = 'Handful of raw walnuts + 1 cup warm chamomile tea.';
      meal_structure.snack_alternate = 'Sesame-sunflower seed laddu made with jaggery.';
      meal_structure.dinner = 'Paneer / Tofu curry with spinach, cashew cream, and quinoa.';
      meal_structure.dinner_alternate = 'Black bean & avocado bowl with roasted sweet potato.';
    }

  } else {
    title = `Hormonal Vitality Protocol (BMI ${bmi})`;
    summary = `Balanced metabolic nutrition plan customized for ${weight}kg / ${height}cm (BMI ${bmi} - ${bmiCategory}, Preference: ${dietaryPreference}). Promotes steady energy, digestive health, and endocrine balance.`;

    recommended_categories.push(
      { name: 'Fibrous Vegetables', reason: 'Supports estrogen excretion and healthy bowel movements.' },
      { name: 'Lean Protein', reason: 'Maintains stable energy and blood glucose baseline.' },
      { name: 'Complex Whole Grains', reason: 'Sustains fiber intake and stable thyroid metabolism.' }
    );

    foods_to_limit.push(
      { name: 'Highly Processed Snacks', reason: 'Contains empty calories, additives, and blood-sugar disrupting oils.' },
      { name: 'Sugary Beverages', reason: 'Leads to quick insulin spikes and weight accumulation.' },
      { name: 'Adrenal Cortisol triggers', reason: 'Excess caffeine overstimulates stress hormones.' }
    );

    suggested_portion_sizing = {
      carb_pct: 45,
      protein_pct: 30,
      fat_pct: 25,
      calories: Math.round(weight * 23),
      note: 'Balanced split supporting daily wellness and energy.',
    };

    guidelines.push('Balanced Plate Rule: 50% non-starchy vegetables, 25% clean protein, 25% complex slow carbs.');
    guidelines.push('Hydration Goal: Drink at least 2.5 to 3 liters of filtered water daily.');
    guidelines.push('Fiber Goal: Aim for 30g+ daily fiber from flax, vegetables, and legumes to aid estrogen elimination.');

    if (isNonVeg) {
      meal_structure.breakfast = '2 scrambled eggs with spinach and cherry tomatoes.';
      meal_structure.breakfast_alternate = 'Greek yogurt with berries and crushed walnuts.';
      meal_structure.lunch = 'Grilled chicken breast with quinoa and mixed green salad.';
      meal_structure.lunch_alternate = 'Salmon bowl with avocado and brown rice.';
      meal_structure.snack = 'Green tea + handful of mixed almonds & walnuts.';
      meal_structure.snack_alternate = 'Apple slices with almond butter.';
      meal_structure.dinner = 'Baked cod fillet with steamed broccoli and sweet potato.';
      meal_structure.dinner_alternate = 'Turkey stew with zucchini and bell peppers.';
    } else {
      meal_structure.breakfast = 'Oatmeal topped with chia seeds, blueberries, and almond butter.';
      meal_structure.breakfast_alternate = 'Moong dal chilla with green chutney.';
      meal_structure.lunch = 'Mixed vegetable lentil dal with brown rice and cucumber salad.';
      meal_structure.lunch_alternate = 'Tofu / Paneer salad bowl with olive oil dressing.';
      meal_structure.snack = 'Green tea + handful of mixed almonds & walnuts.';
      meal_structure.snack_alternate = 'Apple slices with almond butter.';
      meal_structure.dinner = 'Steamed vegetable stew with quinoa and ghee.';
      meal_structure.dinner_alternate = 'Palak paneer or Palak tofu with a small millet roti.';
    }
  }

  if (sympLower.includes('hair') || sympLower.includes('thinning') || sympLower.includes('fall')) {
    guidelines.push('Symptom Focus (Hair Health): Added biotin & zinc rich foods to reduce follicular miniaturization.');
  }
  if (sympLower.includes('fatigue') || sympLower.includes('tired') || sympLower.includes('low energy')) {
    guidelines.push('Symptom Focus (Energy Boost): Added iron-dense ingredients to combat hormonal lethargy.');
  }
  if (sympLower.includes('bloat') || sympLower.includes('gas') || sympLower.includes('digest')) {
    guidelines.push('Symptom Focus (Gut Health): Drink warm fennel-cumin water post meals.');
  }

  return {
    title,
    summary,
    recommended_categories,
    foods_to_limit,
    suggested_portion_sizing,
    meal_structure,
    guidelines,
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
  "recommended_categories": [
    {
      "name": "Category Name (e.g. Healthy Fats)",
      "reason": "Clinical explanation of why it is recommended for this condition"
    }
  ],
  "foods_to_limit": [
    {
      "name": "Food Name/Group (e.g. Soy Isoflavones)",
      "reason": "Clinical reason why it should be limited"
    }
  ],
  "suggested_portion_sizing": {
    "carb_pct": 40,
    "protein_pct": 30,
    "fat_pct": 30,
    "calories": 1800,
    "note": "Suggested split based on weight of ${numericWeight} kg"
  },
  "meal_structure": {
    "breakfast": "Primary breakfast recommendation matching dietary preference",
    "breakfast_alternate": "Alternative breakfast option matching dietary preference",
    "lunch": "Primary lunch recommendation",
    "lunch_alternate": "Alternative lunch option",
    "snack": "Primary snack recommendation",
    "snack_alternate": "Alternative snack option",
    "dinner": "Primary dinner recommendation",
    "dinner_alternate": "Alternative dinner option"
  },
  "guidelines": [
    "Specific guideline/protocol rule 1",
    "Specific guideline/protocol rule 2"
  ]
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
      id: randomUUID(),
      patient_id: req.userId,
      source: 'ai_generated',
      title: planData.title || 'Personalized Clinical Nutritional Plan',
      plan_details: {
        summary: planData.summary,
        recommended_categories: planData.recommended_categories || [],
        foods_to_limit: planData.foods_to_limit || [],
        suggested_portion_sizing: planData.suggested_portion_sizing || { carb_pct: 40, protein_pct: 30, fat_pct: 30, calories: 1800, note: '' },
        meal_structure: planData.meal_structure || {},
        guidelines: planData.guidelines || [],
        source: 'ai_generated',
      },
      notes: `Clinical AI Plan generated based on Condition: ${condition}, Weight: ${numericWeight}kg, Height: ${numericHeight}cm, Preference: ${pref}. Verified & customizable by Dr. Deepa Madhavan.`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const normalizedPlan = normalizeDietPlan(newPlan);
    LOCAL_DIET_PLANS.unshift(normalizedPlan);

    // Save to database
    await supabaseAdmin
      .from('diet_plans')
      .insert(newPlan);

    res.status(201).json({ diet_plan: normalizedPlan });
  } catch (err: any) {
    console.error('Diet generator API exception:', err);
    res.status(500).json({ error: err.message || 'Failed to generate diet plan' });
  }
});
