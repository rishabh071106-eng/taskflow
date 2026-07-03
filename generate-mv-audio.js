#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.ELEVENLABS_API_KEY;
if (!API_KEY) { console.error('Missing ELEVENLABS_API_KEY in .env'); process.exit(1); }

const OUT_DIR = path.join(__dirname, 'audio-mv');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Harsh/intense voice for grind, discipline, quick
// Soft/soothing voice for morning, confidence, nature, focus
const VOICE_HARSH = 'ErXwobaYiN019PkySvjV'; // Antoni — deep, intense
const VOICE_SOFT  = 'EXAVITQu4vr4xnSDxMaL'; // Bella — warm, soothing

const speeches = [
  // ── GRIND (harsh, intense) ──
  { id: 'mv1', voice: 'harsh', text: "Keep Moving Forward. Every single day you have a choice. You can stay in bed, stay comfortable, stay average. Or you can get up, push through the pain, and become someone extraordinary. The grind never stops. The hustle never sleeps. And neither should your ambition. You didn't come this far to only come this far. Keep moving. Keep fighting. Keep grinding." },
  { id: 'mv4', voice: 'harsh', text: "Run Your Race. Don't stop when you're tired. Stop when you're done. The road is long, the hills are steep, but you were built for this. Every step forward is a step closer to the person you were meant to become. So lace up, show up, and run your race like your life depends on it. Because it does." },
  { id: 'mv5', voice: 'harsh', text: "Outwork Everyone. Hard work beats talent when talent doesn't work hard. You want to be the best? Then outwork everyone in the room. Be the first one in and the last one out. While they sleep, you grind. While they party, you study. While they rest, you work. That's the price of greatness. Pay it." },
  { id: 'mv8', voice: 'harsh', text: "Sprint to Greatness. Champions train. Losers complain. Which one are you going to be? Every morning you wake up, you make that choice. You either chase your dreams or you chase comfort. You can't have both. So sprint. Sprint like your future depends on it. Because it does." },
  { id: 'mv33', voice: 'harsh', text: "Daily Grind. Success is the sum of small efforts repeated day after day after day. There are no shortcuts. There are no hacks. There is only the work. Show up every single day. Do the hard things. Make the sacrifices. And one day, you'll look back and realize that every early morning, every late night, every moment of doubt was worth it." },
  { id: 'mv34', voice: 'harsh', text: "Never Quit. It does not matter how slowly you go, as long as you do not stop. The world will try to break you. People will doubt you. Your own mind will betray you. But you do not quit. You do not give up. You keep pushing, keep fighting, keep believing. Because the only way you lose is if you stop." },
  { id: 'mv35', voice: 'harsh', text: "Sweat Equity. The harder you work, the luckier you get. Luck is not some magical force. Luck is preparation meeting opportunity. And preparation means putting in the sweat, the tears, the hours that nobody sees. So get to work. Build your empire one brick at a time." },
  { id: 'mv36', voice: 'harsh', text: "All In. Go all in or don't go at all. Half effort gets you nowhere. You want something? Then burn the boats. Eliminate the backup plan. When there's no plan B, plan A has to work. That's when you become unstoppable. That's when greatness finds you." },

  // ── DISCIPLINE (harsh, commanding) ──
  { id: 'mv7', voice: 'harsh', text: "Push Your Limits. Growth begins at the edge of your comfort zone. If you're comfortable, you're not growing. If it doesn't challenge you, it doesn't change you. So push. Push harder than yesterday. Push through the pain, through the fear, through the doubt. On the other side of that pain is the person you're meant to become." },
  { id: 'mv25', voice: 'harsh', text: "Iron Will. The pain you feel today is the strength you feel tomorrow. Do not run from the pain. Embrace it. Welcome it. Let it forge you into something unbreakable. Iron sharpens iron. Struggle builds strength. And you, you are being forged in fire right now." },
  { id: 'mv26', voice: 'harsh', text: "No Shortcuts. Discipline is the bridge between goals and accomplishment. There are no shortcuts to any place worth going. Every day you must choose discipline over desire, focus over distraction, hard work over easy living. That is the price. And it is worth every single moment." },
  { id: 'mv27', voice: 'harsh', text: "Build Your Body. Take care of your body. It's the only place you have to live. Your body is your temple, your weapon, your vehicle through life. Treat it with respect. Train it with purpose. Push it to its limits. A strong body builds a strong mind." },
  { id: 'mv28', voice: 'harsh', text: "Relentless Training. Sweat now, shine later. Every rep, every set, every mile is an investment in your future self. The gym is your church. The track is your battlefield. And every single workout is a war you're winning against mediocrity." },
  { id: 'mv29', voice: 'harsh', text: "Forge Ahead. Every rep counts. Every set matters. Do not waste a single moment. You are building something. Not just muscle, not just endurance, but character. The discipline you build in training carries over into every area of your life. So forge ahead." },
  { id: 'mv30', voice: 'harsh', text: "Strength Within. You don't find willpower. You create it. Every time you do what you don't feel like doing, you build willpower. Every time you resist temptation, you grow stronger. Willpower is a muscle. Train it every single day." },
  { id: 'mv31', voice: 'harsh', text: "Power Hour. One hour of focused effort changes everything. Just one hour. Sixty minutes of pure, undistracted, intense work. That's all it takes to move mountains. Stop wasting time on things that don't matter. Give yourself one power hour every single day and watch your life transform." },
  { id: 'mv32', voice: 'harsh', text: "Mind Over Matter. Your body achieves what your mind believes. The mind quits a thousand times before the body does. So train your mind first. Tell yourself you can. Believe it with every fiber of your being. And then prove it." },
  { id: 'mv37', voice: 'harsh', text: "Beast Mode. Excuses don't burn calories. Excuses don't build empires. Excuses don't change lives. So stop making them. Stop blaming circumstances. Stop waiting for the perfect time. The time is now. Activate beast mode. And never look back." },

  // ── QUICK BOOST (intense but concise) ──
  { id: 'mv43', voice: 'harsh', text: "Strong is the new beautiful. You are powerful. You are capable. You are relentless. Every drop of sweat is proof that you are alive and fighting. Keep going. Keep pushing. You are unstoppable." },
  { id: 'mv44', voice: 'soft', text: "Choose Happiness. Happiness is a choice, not a result. You don't need everything to be perfect to be happy. Choose joy. Choose gratitude. Choose to see the beauty in every moment. Your happiness is in your hands." },
  { id: 'mv49', voice: 'harsh', text: "Five Minute Fire. You are one decision away from a completely different life. One decision. One moment of courage. Five minutes of action can change everything. Stop waiting for the perfect moment. The perfect moment is right now. Go." },
  { id: 'mv50', voice: 'soft', text: "Deep Blue Calm. The secret of getting ahead is getting started. Take a deep breath. Clear your mind. And take that first step. You don't need to see the whole staircase. Just take the first step. The rest will follow." },

  // ── MORNING (warm, inspiring) ──
  { id: 'mv6', voice: 'soft', text: "Rise and Grind. Every morning is a chance to start again. A new day. A fresh beginning. The sun is rising, and so are you. Take a deep breath. Feel the energy of a brand new day filling your lungs. Today is full of possibility. Today is yours to shape. Make it count." },
  { id: 'mv10', voice: 'soft', text: "Golden Hour Awakening. Wake up with determination. Go to bed with satisfaction. This golden hour, this precious time when the world is still quiet, this is your time. Use it wisely. Set your intentions. Visualize your success. And then go out there and make it happen." },
  { id: 'mv11', voice: 'soft', text: "New Dawn, New Goals. Today is the day you change your life. Not tomorrow. Not next week. Today. Right now. The universe has given you another chance, another twenty-four hours to move closer to your dreams. Don't waste a single moment." },
  { id: 'mv12', voice: 'soft', text: "Sunrise Strength. Every sunrise brings a new opportunity. The darkness of yesterday is gone. The mistakes of the past cannot touch you here. You are standing in the light of a brand new day, full of strength, full of hope, full of infinite possibility." },
  { id: 'mv13', voice: 'soft', text: "Chase the Light. Be the energy you want to attract. Start this day with positivity, with purpose, with passion. When you radiate good energy, the universe responds. So shine bright today. Be the light that others are drawn to." },
  { id: 'mv14', voice: 'soft', text: "Morning Momentum. Start before you're ready. Don't wait for motivation. Don't wait for inspiration. Just start. Take that first step. Build momentum. Once you're moving, nothing can stop you. The hardest part is always the beginning." },
  { id: 'mv15', voice: 'soft', text: "Break of Dawn. Discipline is choosing what you want most over what you want now. This morning, you chose to rise. You chose growth over comfort. You chose your future over your pillow. That choice, that discipline, that is what separates the extraordinary from the ordinary." },
  { id: 'mv16', voice: 'soft', text: "First Light Focus. Win the morning, win the day. The first hour of your day sets the tone for everything that follows. So spend it wisely. Move your body. Feed your mind. Set your goals. And then go conquer the world." },

  // ── CONFIDENCE (warm, empowering) ──
  { id: 'mv2', voice: 'soft', text: "Victory Is Yours. Success is not given. It is earned. And you have earned it. Every struggle, every setback, every moment of doubt has prepared you for this. You are ready. You are worthy. Victory is not just possible. It is inevitable. Believe that." },
  { id: 'mv3', voice: 'soft', text: "Unleash Your Power. You are stronger than you think. You are braver than you believe. And you are more capable than you can possibly imagine. Stop playing small. Stop dimming your light for others. Unleash the full power that lives inside you. The world needs to see it." },
  { id: 'mv9', voice: 'soft', text: "Stay Positive. Your attitude determines your altitude. When you choose to see the good in every situation, you rise above the noise. Positivity is not about ignoring problems. It is about believing in your ability to solve them. Stay positive. Stay strong. Stay you." },
  { id: 'mv45', voice: 'soft', text: "Rise With The Sun. Be so good they can't ignore you. Excellence is not an act. It is a habit. Show up every day with your best self. Pour everything you have into your craft. And let your work speak so loudly that the world has no choice but to listen." },
  { id: 'mv46', voice: 'soft', text: "Sky Is The Limit. Dream bigger than your fears. Your fears are just stories your mind tells you to keep you safe. But safe is not where greatness lives. Dream big. Dream bold. Dream so big that it scares you. Because on the other side of fear is everything you've ever wanted." },
  { id: 'mv47', voice: 'soft', text: "Golden Glow. Shine so bright they need sunglasses. You were born to stand out, not to fit in. Your uniqueness is your superpower. Your story is your strength. So stop hiding. Step into the spotlight. And let the world see the incredible person you truly are." },
  { id: 'mv48', voice: 'soft', text: "Radiant Energy. Your energy introduces you before you even speak. Walk into every room knowing your worth. Stand tall. Speak with confidence. Radiate the kind of energy that lifts others up. You are a force of nature. Own it." },

  // ── NATURE (calm, reflective) ──
  { id: 'mv17', voice: 'soft', text: "Peaceful Power. Stillness is where creativity and solutions are found. In the quiet moments, between the chaos and the noise, there is a space of perfect peace. Find that space. Breathe into it. Let the stillness wash over you. In this calm, you will find answers you never knew you were looking for." },
  { id: 'mv18', voice: 'soft', text: "Ocean of Calm. Be like water. Flexible, yet unstoppable. Water does not fight obstacles. It flows around them. It adapts, it persists, and eventually, it wears down even the hardest stone. Be like the ocean. Calm on the surface. Powerful beneath. Unstoppable in your purpose." },
  { id: 'mv19', voice: 'soft', text: "Waves of Determination. Persistence breaks down all resistance. Like the waves that shape the shoreline, your consistent effort will reshape your reality. Wave after wave, day after day. You may not see the change happening, but it is. Trust the process. Trust yourself." },
  { id: 'mv20', voice: 'soft', text: "Endless Horizon. Think big, start small, act now. Look at the horizon. See how it stretches endlessly before you? That is your potential. Limitless. Boundless. Infinite. But every journey to the horizon begins with a single step. Take that step now." },
  { id: 'mv21', voice: 'soft', text: "Tides of Change. Embrace change. It is your greatest teacher. Like the tides that rise and fall, change is constant and natural. Don't resist it. Flow with it. Every ending is a new beginning. Every change is an opportunity to grow into someone even more extraordinary." },
  { id: 'mv22', voice: 'soft', text: "Deep Breath. In the middle of difficulty lies opportunity. Take a deep breath. Hold it. Now release. With every exhale, let go of what no longer serves you. With every inhale, breathe in possibility. You are exactly where you need to be right now." },
  { id: 'mv23', voice: 'soft', text: "Tranquil Strength. Calmness is a superpower. In a world that glorifies hustle and noise, there is immense power in being still. The calmest person in the room is often the strongest. Cultivate inner peace. Let tranquility be your foundation. From that place of calm, you can move mountains." },
  { id: 'mv24', voice: 'soft', text: "Shore of Serenity. Peace is the foundation of productivity. You cannot pour from an empty cup. You cannot create from a place of chaos. Find your shore of serenity. Rest there. Recharge there. And then, from that place of peace, go change the world." },

  // ── FOCUS (calm, meditative) ──
  { id: 'mv38', voice: 'soft', text: "Flow State. When you are in the zone, nothing can stop you. That state of perfect focus, where time dissolves and you become one with your work. That is flow. Cultivate it. Protect it. Remove every distraction. And let yourself sink into the deep, beautiful river of focused creation." },
  { id: 'mv39', voice: 'soft', text: "Crystal Clear. Clarity comes from action, not from thought. Stop overthinking. Stop analyzing. Start doing. With every action you take, your path becomes clearer. Your vision becomes sharper. Your purpose becomes more defined. Move forward, and clarity will follow." },
  { id: 'mv40', voice: 'soft', text: "Still Waters Run Deep. Focus on progress, not perfection. Perfection is the enemy of done. Instead, focus on getting a little better every single day. Small improvements, consistent effort, quiet dedication. Like still waters that run deep, your steady progress will take you further than any sprint." },
  { id: 'mv41', voice: 'soft', text: "Inner Peace. A calm mind is an unstoppable mind. When your thoughts are clear and your heart is at peace, there is nothing you cannot accomplish. Silence the inner critic. Quiet the noise. Find that still point within you, and from there, create something extraordinary." },
  { id: 'mv42', voice: 'soft', text: "Breathe and Believe. Believe you can and you're halfway there. Close your eyes. Take a deep breath. Now picture your goal. See it clearly. Feel it in your bones. You can do this. You were made for this. Breathe in belief. Breathe out doubt. You are ready." },
];

const VOICE_MAP = {
  harsh: VOICE_HARSH,
  soft: VOICE_SOFT,
};

async function generateOne(entry) {
  const outFile = path.join(OUT_DIR, entry.id + '.mp3');
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > 1000) {
    console.log(`  SKIP ${entry.id} (already exists)`);
    return true;
  }

  const voiceId = VOICE_MAP[entry.voice];
  const stability = entry.voice === 'harsh' ? 0.35 : 0.55;
  const similarity = 0.80;
  const style = entry.voice === 'harsh' ? 0.6 : 0.3;

  try {
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: entry.text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability,
          similarity_boost: similarity,
          style,
          use_speaker_boost: true,
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`  FAIL ${entry.id}: ${resp.status} ${errText.slice(0, 200)}`);
      return false;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(outFile, buffer);
    console.log(`  OK   ${entry.id} — ${(buffer.length / 1024).toFixed(0)}KB`);
    return true;
  } catch (e) {
    console.error(`  ERR  ${entry.id}: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(`Generating ${speeches.length} motivational audio files...`);
  console.log(`Output: ${OUT_DIR}\n`);

  let ok = 0, fail = 0;
  for (const entry of speeches) {
    const success = await generateOne(entry);
    if (success) ok++; else fail++;
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone: ${ok} succeeded, ${fail} failed`);
}

main().catch(e => { console.error(e); process.exit(1); });
