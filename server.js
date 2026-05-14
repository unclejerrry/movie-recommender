import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(express.json());
app.use(express.static('.'));

const client = new Anthropic();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const SYSTEM_PROMPT =
  'You are a film expert with deep knowledge of cinema across all eras and genres.';

app.post('/recommend', async (req, res) => {
  const { movies } = req.body ?? {};

  if (!Array.isArray(movies) || movies.length !== 3 || movies.some(m => !String(m).trim())) {
    return res.status(400).json({ error: 'Please provide exactly 3 movies.' });
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
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const raw = response.content[0]?.text?.trim() ?? '';
    const match = raw.match(/\[[\s\S]*\]/);
    const films = JSON.parse(match ? match[0] : raw);

    if (!Array.isArray(films) || films.length === 0) {
      throw new Error('Unexpected response format.');
    }

    supabase
      .from('searches')
      .insert({ movies: [m1, m2, m3], recommendations: films })
      .then(({ error }) => { if (error) console.error('Supabase insert error:', error.message); });

    res.json({ films });
  } catch (err) {
    const message = err instanceof Anthropic.APIError
      ? err.message
      : (err.message || 'Something went wrong.');
    res.status(500).json({ error: message });
  }
});

app.get('/api/count', async (req, res) => {
  const { count, error } = await supabase
    .from('searches')
    .select('*', { count: 'exact', head: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ count });
});

app.get('/history', (req, res) => {
  res.sendFile('history.html', { root: '.' });
});

app.get('/api/history', async (req, res) => {
  const { data, error } = await supabase
    .from('searches')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ searches: data });
});

app.get('/favourites', (req, res) => {
  res.sendFile('favourites.html', { root: '.' });
});

app.get('/api/favourites', async (req, res) => {
  const { data, error } = await supabase
    .from('favourites')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ favourites: data });
});

app.post('/api/favourites', async (req, res) => {
  const { title, year, reason, mood } = req.body ?? {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const { data, error } = await supabase
    .from('favourites')
    .insert({ title, year, reason, mood })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ favourite: data });
});

app.delete('/api/favourites/:id', async (req, res) => {
  const { error } = await supabase
    .from('favourites')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
