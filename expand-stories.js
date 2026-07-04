#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const QUOTES_PATH = path.join(__dirname, 'daily-quotes.json');
const BATCH_SIZE = 5;
const DELAY_MS = 2000;
const TARGET_WORDS = 1800;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

async function expandStory(quote) {
  const prompt = `You are writing an engaging, inspiring long-form story for a daily wisdom app called Brodoit. The story accompanies this quote:

"${quote.q}" — ${quote.a}

Current short story (expand this significantly):
${quote.s}

Write a compelling, deeply engaging story of approximately ${TARGET_WORDS} words (5-10 minute read). Requirements:
- Start with a vivid, cinematic scene or moment that hooks the reader immediately
- Weave in real historical anecdotes, scientific research, and personal development insights
- Include at least 2-3 specific real-world examples or case studies
- Use narrative storytelling — not bullet points or listicle format
- Mix philosophical depth with practical life application
- End with a powerful, memorable closing that ties back to the quote
- Write in a warm, conversational but intelligent tone — like a wise friend sharing wisdom over coffee
- Include surprising facts or counterintuitive insights that make the reader think
- NO headers, NO bullet points, NO numbered lists — pure flowing narrative prose
- Do NOT include the quote itself in the story text
- Do NOT start with "In" or "The quote"

Return ONLY the story text, nothing else.`;

  return callClaude(prompt);
}

async function main() {
  const quotes = JSON.parse(fs.readFileSync(QUOTES_PATH, 'utf8'));
  const startIdx = parseInt(process.argv[2] || '0', 10);
  const endIdx = parseInt(process.argv[3] || String(quotes.length), 10);

  console.log(`Expanding stories ${startIdx} to ${endIdx - 1} (${endIdx - startIdx} total)`);

  let processed = 0;
  for (let i = startIdx; i < endIdx; i += BATCH_SIZE) {
    const batch = [];
    for (let j = i; j < Math.min(i + BATCH_SIZE, endIdx); j++) {
      batch.push(j);
    }

    const results = await Promise.all(batch.map(async (idx) => {
      try {
        const expanded = await expandStory(quotes[idx]);
        const wordCount = expanded.split(/\s+/).length;
        console.log(`  [${idx}] "${quotes[idx].q.substring(0, 50)}..." → ${wordCount} words`);
        return { idx, text: expanded };
      } catch (err) {
        console.error(`  [${idx}] ERROR: ${err.message}`);
        return { idx, text: null };
      }
    }));

    for (const r of results) {
      if (r.text) {
        quotes[r.idx].s = r.text;
        processed++;
      }
    }

    // Save after each batch
    fs.writeFileSync(QUOTES_PATH, JSON.stringify(quotes, null, 2));
    console.log(`Batch done. Saved. ${processed} expanded so far. (${i + batch.length}/${endIdx})`);

    if (i + BATCH_SIZE < endIdx) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\nDone! Expanded ${processed} stories.`);

  // Print stats
  const updated = JSON.parse(fs.readFileSync(QUOTES_PATH, 'utf8'));
  const words = updated.slice(startIdx, endIdx).map(x => (x.s || '').split(/\s+/).length);
  console.log(`Avg words: ${Math.round(words.reduce((a, b) => a + b, 0) / words.length)}`);
  console.log(`Min: ${Math.min(...words)}, Max: ${Math.max(...words)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
