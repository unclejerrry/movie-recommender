import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const app = express();
const anthropic = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FREE_DAILY_LIMIT = 3;
const SYSTEM_PROMPT = 'You are a film expert with deep knowledge of cinema across all eras and genres.';

// ── Helpers ───────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  next();
}

async function getOrCreateProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (data) return data;
  const { data: created } = await supabase.from('profiles').insert({ id: userId }).select().single();
  return created ?? { id: userId, plan: 'free', stripe_customer_id: null };
}

async function searchesToday(userId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const { count } = await supabase
    .from('searches')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start.toISOString());
  return count ?? 0;
}

// ── Stripe webhook — raw body BEFORE express.json() ───────────────────

app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session.mode === 'subscription' && session.payment_status === 'paid') {
        await supabase.from('profiles')
          .update({ plan: 'pro', stripe_subscription_id: session.subscription })
          .eq('stripe_customer_id', session.customer);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await supabase.from('profiles')
        .update({ plan: 'free', stripe_subscription_id: null })
        .eq('stripe_customer_id', sub.customer);
    }
  } catch (err) {
    console.error('[webhook] handler error:', err);
  }

  res.json({ received: true });
});

// ── Standard middleware ───────────────────────────────────────────────

app.use(express.json());
app.use(express.static('.'));

// ── Public config ─────────────────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// ── Auth pages ────────────────────────────────────────────────────────

app.get('/signin', (_req, res) => res.sendFile('signin.html', { root: '.' }));
app.get('/signup', (_req, res) => res.sendFile('signup.html', { root: '.' }));

// ── User plan + daily usage ───────────────────────────────────────────

app.get('/api/me', requireAuth, async (req, res) => {
  const profile = await getOrCreateProfile(req.user.id);
  if (profile.plan === 'pro') return res.json({ plan: 'pro' });
  const used = await searchesToday(req.user.id);
  res.json({ plan: 'free', searchesToday: used, searchLimit: FREE_DAILY_LIMIT });
});

// ── Recommend ─────────────────────────────────────────────────────────

app.post('/recommend', requireAuth, async (req, res) => {
  const { movies } = req.body ?? {};
  if (!Array.isArray(movies) || movies.length !== 3 || movies.some(m => !String(m).trim())) {
    return res.status(400).json({ error: 'Please provide exactly 3 movies.' });
  }

  const profile = await getOrCreateProfile(req.user.id);
  if (profile.plan !== 'pro') {
    const used = await searchesToday(req.user.id);
    if (used >= FREE_DAILY_LIMIT) {
      return res.status(429).json({ error: 'Daily search limit reached.', limitReached: true });
    }
  }

  const [m1, m2, m3] = movies.map(m => String(m).trim());

  const userPrompt = `A cinephile loves these three films: "${m1}", "${m2}", and "${m3}".

Recommend exactly 5 films they would love but may not have seen. Consider themes, tone, visual style, pacing, and emotional resonance — look for films that share DNA with their choices.

Return ONLY a valid JSON array — no markdown fences, no explanation, nothing else. Use this exact structure:
[
  {
    "title": "Film Title",
    "year": 1999,
    "reason": "One precise sentence explaining why this matches their taste.",
    "mood": "Evocative Mood Tag"
  }
]

Mood tag examples: "Haunting & Beautiful", "Edge-of-Seat Thriller", "Mind-Bending", "Darkly Comic", "Epic & Sweeping", "Intimate & Raw", "Dreamlike", "Slow Burn", "Bittersweet", "Visually Stunning", "Surreal & Unsettling", "Tender & Heartbreaking".`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0]?.text?.trim() ?? '';
    const match = raw.match(/\[[\s\S]*\]/);
    const films = JSON.parse(match ? match[0] : raw);
    if (!Array.isArray(films) || films.length === 0) throw new Error('Unexpected response format.');

    supabase.from('searches')
      .insert({ movies: [m1, m2, m3], recommendations: films, user_id: req.user.id })
      .then(({ error }) => { if (error) console.error('Supabase insert error:', error.message); });

    res.json({ films });
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? err.message : (err.message || 'Something went wrong.');
    res.status(500).json({ error: message });
  }
});

// ── Global search count ───────────────────────────────────────────────

app.get('/api/count', async (_req, res) => {
  const { count, error } = await supabase.from('searches').select('*', { count: 'exact', head: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count });
});

// ── History ───────────────────────────────────────────────────────────

app.get('/history', (_req, res) => res.sendFile('history.html', { root: '.' }));

app.get('/api/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('searches').select('*')
    .eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ searches: data });
});

// ── Favourites ────────────────────────────────────────────────────────

app.get('/favourites', (_req, res) => res.sendFile('favourites.html', { root: '.' }));

app.get('/api/favourites', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('favourites').select('*')
    .eq('user_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ favourites: data });
});

app.post('/api/favourites', requireAuth, async (req, res) => {
  const { title, year, reason, mood } = req.body ?? {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const { data, error } = await supabase.from('favourites')
    .insert({ title, year, reason, mood, user_id: req.user.id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ favourite: data });
});

app.delete('/api/favourites/:id', requireAuth, async (req, res) => {
  const { error } = await supabase.from('favourites').delete()
    .eq('id', req.params.id).eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Stripe checkout ───────────────────────────────────────────────────

app.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  try {
    const profile = await getOrCreateProfile(req.user.id);
    let customerId = profile.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { supabase_uid: req.user.id },
      });
      customerId = customer.id;
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('id', req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: `${req.protocol}://${req.get('host')}/?checkout=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
