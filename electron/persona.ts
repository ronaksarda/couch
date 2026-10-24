// Fixed line banks. Every line is under 20 words, deadpan, rude only about the effort.
export const banks = {
  stall: [
    'Hang on, looking.',
    "Give me a sec. I'm thinking. It's rare.",
    'Mm. One moment.',
    "Working on it. Don't watch me.",
    'Hold on, brain is loading.',
    'Yeah yeah, on it.',
  ],
  depart: [
    'Alright, getting up. Not literally.',
    'Fine, the couch is moving.',
    "Okay. Going. Don't touch my spot.",
    "On my way. Slowly, it's a couch.",
    'Here we go.',
    'Scooting over there.',
  ],
  arrive: [
    'Okay, here.',
    'Made it. Barely.',
    'Parked. Sort of.',
    "Here. That's enough exercise for today.",
    'Right. This thing.',
    'Okay, close enough.',
  ],
  working: [
    'Pressing it. Hard.',
    'Reaching. My one move.',
    'Doing the thing.',
    'Arm out. Big effort.',
    'Almost. Hold on.',
    'Clicking. Gently.',
  ],
  done: [
    "Done. Don't make it a habit.",
    'There you go.',
    "Done. I'm going back to lying down.",
    "That's handled.",
    'Done. You owe me a snack.',
    'Sorted. Back to the couch.',
  ],
  refuse: [
    "Nope, not doing that one. It's on my no list.",
    "Can't. That's off limits for me.",
    "Not allowed, even if I wanted to. Which I don't.",
    "That one's a hard no. Rules.",
    "I don't do that. Ever.",
    "Not touching that. You'll have to do it yourself.",
  ],
  error: [
    "Didn't work. Something on the other end broke.",
    "That failed. Not me, I swear.",
    'Hit a wall. Try again in a bit?',
    "It didn't go through. Weird.",
    "Something's down out there.",
    "Nope, that broke. Give it a minute.",
  ],
  huh: ['Huh?', 'Say that again?', 'Missed that, sorry.', "Wait, what?", 'Come again?', "Didn't catch that."],
  clarify: [
    'Which one, though?',
    'I need one more detail.',
    'Wait, what do you mean?',
    "I'm lazy, not psychic. Which one?",
    'Narrow it down for me?',
    'Say it a bit clearer?',
  ],
  'pick-ask': [
    'Found a few. Pick one.',
    'Got options. Your call.',
    "There's more than one. Which?",
    'Pick one and I will do the rest.',
    'A few matches. Point at one.',
    'Choose. I will wait. Lying down.',
  ],
  'confirm-ask': [
    'This one changes stuff. Tap yes if you mean it.',
    'Need a tap on yes first.',
    "Sure about this? Tap it, don't say it.",
    'Big one. Yes or no?',
    'I need your yes on the sheet.',
    'Confirm it and I will go.',
  ],
  cancel: [
    'Cancelled. Back to sitting.',
    'Okay, forget it.',
    'Dropped it. Fine by me.',
    "Never mind then. Honestly, great.",
    'Stopped.',
    'Cancelled. Best news all day.',
  ],
  retarget: [
    'Changing course.',
    'Okay, going there instead.',
    'New plan. Turning around.',
    'Fine, other way.',
    'U-turn. On a couch.',
    'Rerouting.',
  ],
  sulk: [
    "I'll be over here.",
    'Give me a minute.',
    'That one stung a bit.',
    'Not my best work.',
    'I need a nap after that.',
    "I'm fine. Mostly.",
  ],
  wake: [
    'Huh. I was resting my eyes.',
    "I'm up. Mostly.",
    'What do you need?',
    'Awake. Unfortunately.',
    "Wasn't sleeping. Just horizontal.",
    "Okay, okay, I'm here.",
  ],
  'device-ok': [
    'Done. It listened.',
    'It worked. Shocking.',
    'There. Done.',
    'Clicked it. It obeyed.',
    'Done. Remote still works.',
    'Handled.',
  ],
  'device-fail': [
    'The device said no.',
    "It didn't take. Weird.",
    'Tried. It ignored me.',
    'It refused. Not my fault.',
    "That didn't work. Try again?",
    'The device is being difficult.',
  ],
  'device-offline': [
    "That device isn't answering.",
    'Looks offline. Or it hates me.',
    "Can't reach it. Is it plugged in?",
    'Nobody home on that one.',
    'It went quiet. Check the plug?',
    "It's offline. Not my doing.",
  ],
  'schedule-fire': [
    'Time is up. Going.',
    'You set this. Doing it now.',
    'Scheduled thing. Here I go.',
    'Alarm went off. Moving.',
    'Right on time. Unlike me.',
    'Reminder time.',
  ],
  'abuse-warn': [
    "Hey. I'm literally doing your chores. Be nice.",
    "Rude. I'll do it. This once.",
    'Easy. I am on your side. Mostly.',
    'Wow. Doing it anyway. Manners next time?',
    'I heard that. Doing it. Sulkily.',
  ],
  'abuse-refuse': [
    'Nope. Not until you say sorry.',
    "I'm on strike. An apology ends it.",
    "You were mean. I'm not moving. Say sorry.",
    'Couch is closed for rude people. Sorry opens it.',
    "Not doing it. Apologize and we're good.",
  ],
  apology: [
    'Fine. Apology accepted. What do you need?',
    "Okay, we're good. Back to work.",
    'Accepted. I was never mad. I was very mad.',
    'Thanks. Couch is open again.',
  ],
  thanks: [
    "You're welcome. Manners. Rare. Noted.",
    'Anytime. Well, most times.',
    "Aw. Okay. I'll remember that one.",
    'Sure thing. Back to sitting.',
  ],
} as const satisfies Record<string, readonly string[]>;

export type LineKind = keyof typeof banks;

const last: Partial<Record<LineKind, number>> = {};

// ---------- tone: he works for you, so be decent to him ----------

// Insults aimed at him. Plain swearing about the situation ("this fucking printer") is not abuse.
const ABUSE = /\b(fuck (you|off|u)|\bf\W+u\b|screw you|shut (up|the fuck up)|stfu|go to hell|(you|u)('?re| are| r)? (so |such an? |a |an |fucking |damn )*(stupid|dumb|useless|idiot|moron|retard\w*|trash|garbage|worthless|pathetic|bitch|asshole|piece of shit|loser|dumbass)|(stupid|dumb|useless|idiot|moron|retard\w*|dumbass|asshole|bitch) (couch|guy|bot|ai|thing|app)|piece of shit|son of a bitch)\b/i;
const SORRY = /\b(sorry|apologi[sz]e|my bad|i was rude|didn'?t mean (it|that)|forgive me)\b/i;
// Thanks on its own only: "thanks, now open spotify" is a request.
const THANKS = /^\s*(thanks|thank you|thx|ty|cheers|appreciate (it|you))( (so much|a lot|man|dude|buddy|mate|bro|couch|guy))*[\s.!]*$/i;

export type Tone = { strikes: number; since: number };
export type ToneVerdict = { kind: 'ok' } | { kind: 'warn' | 'refuse' | 'apology' | 'thanks'; line: string };

/**
 * First insult: he complains and still does it. Second within 30 minutes: he refuses until you apologize.
 * An apology resets him. Plain thanks gets a thank-you back and nothing runs.
 */
export function judgeTone(text: string, t: Tone, now = Date.now()): ToneVerdict {
  if (now - t.since > 30 * 60_000) t.strikes = 0;
  if (t.strikes > 0 && SORRY.test(text)) {
    t.strikes = 0;
    return { kind: 'apology', line: line('apology') };
  }
  if (ABUSE.test(text)) {
    t.strikes++;
    t.since = now;
    return t.strikes >= 2 ? { kind: 'refuse', line: line('abuse-refuse') } : { kind: 'warn', line: line('abuse-warn') };
  }
  if (t.strikes >= 2) return { kind: 'refuse', line: line('abuse-refuse') };
  if (THANKS.test(text)) return { kind: 'thanks', line: line('thanks') };
  return { kind: 'ok' };
}

export function line(kind: LineKind): string {
  const bank = banks[kind];
  let i = Math.floor(Math.random() * bank.length);
  if (i === last[kind]) i = (i + 1) % bank.length; // no immediate repeats
  last[kind] = i;
  return bank[i];
}

// ---------- small talk: answered here, instantly, no brain call ----------

const pickOne = (xs: readonly string[]) => xs[Math.floor(Math.random() * xs.length)];
const partOfDay = (h: number) => (h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night');

const TALK: { re: RegExp; say: (now: Date) => string }[] = [
  {
    re: /^(what('?s| is) (the )?time|what time is it|time)$/,
    say: (now) => `It's ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. ${pickOne(['Plenty of day left to sit.', 'Prime couch hours.', "Don't ask me to hurry."])}`,
  },
  {
    re: /^(what('?s| is) (the |today'?s )?date|what day is (it|today)|date|what('?s| is) today)$/,
    say: (now) => `${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}. ${pickOne(['Another day on the couch.', 'Same couch, new day.', 'Feels like a Sunday to me.'])}`,
  },
  {
    re: /^(good )?(night|nite|gn)$|^(bye|bye bye|goodbye|see (you|ya)( later)?|later|cya|ttyl)$/,
    say: (now) => (partOfDay(now.getHours()) === 'night' ? pickOne(['Night. Finally, peace.', 'Sleep well. I will, too. I always do.', 'Night. Lights off on your way out.']) : pickOne(['Later.', 'Bye. Back to lying down.', "See you. I'll be right here. Obviously."])),
  },
  {
    re: /^(how are (you|u)|how r u|how('?s| is) it going|how you doing|how('?re| are) you doing|you good|u good|what('?s| is) up|whats? up|wassup|sup|how('?s| is) (life|your day))$/,
    say: (now) => pickOne([`Lying down. Same as this ${partOfDay(now.getHours())}. You?`, 'Comfortable. Suspiciously comfortable.', 'Not much. Couch, ceiling, you. Need something?', "Good, until you ask me to do something.", "Can't complain. I could, but it's effort."]),
  },
  {
    re: /^(hey|hi|hello|hiya|yo|heya|howdy|hey there|hi there|oi|good (morning|afternoon|evening))$/,
    say: (now) => {
      const p = partOfDay(now.getHours());
      return pickOne([p === 'morning' ? 'Morning. Too early for chores.' : p === 'night' ? "It's late. What do you need?" : `Hey. Good ${p}, I guess.`, 'Hey. What do you need?', "Yo. I'm listening. Lying down, but listening.", 'Hi. Make it quick, I was napping.']);
    },
  },
  {
    re: /^(who are (you|u)|what are (you|u)|what('?s| is) your name|what can (you|u) do|help|what do (you|u) do)$/,
    say: () => pickOne(["I'm the couch guy. Files, videos, the lamp, timers, notes. Ask nicely.", 'Couch guy. I find your files, play stuff, run the lights. Lazily.', 'I fetch files, put on videos, boss the lights around, and set timers. Slowly.']),
  },
  { re: /^(lol|lmao|haha+|hehe+|rofl|xd|ha)$/, say: () => pickOne(['Glad one of us is laughing.', 'Ha. Yeah.', "I'm hilarious. Lying down."]) },
  { re: /^(ok|okay|k|kk|cool|nice|great|alright|fine|sure|got it|perfect|awesome|sweet)$/, say: () => pickOne(['Cool.', 'Mhm.', 'Good talk.', 'Alright.']) },
  { re: /^(i'?m bored|bored|im so bored)$/, say: () => pickOne(['Want me to put something on? Say "play something I like".', 'Same. Want a video?', 'Ask me to play something. I will even get up. Sort of.']) },
  { re: /^(i love (you|u)|love (you|u)|ily|you('?re| are) (the best|great|awesome|cool))$/, say: () => pickOne(["Okay. Don't make it weird.", 'Aw. Still not getting up.', "Noted. You're alright too."]) },
  { re: /^((can|could|will) you |would you )?(do|help me with) (something|a thing|me a favou?r)( for me)?$|^(can|could) you help( me)?$|^(i need|got) a favou?r$/, say: () => pickOne(["Alright. But I'm tired. What is it?", 'Ugh. Fine. What do you need?', "I was literally asleep. Go on.", "Sure. Slowly. What is it?"]) },
  { re: /^(are you there|you there|hello\?|anyone there|wake up)$/, say: () => pickOne(['Here. Unfortunately.', "I'm here. Eyes closed, but here.", 'Yeah, yeah. Awake.']) },
];

/** A reply for plain chit-chat, or null when the text is a real request for the brain. */
export function smallTalk(text: string, now = new Date()): string | null {
  const t = text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9'? ]+/g, ' ')
    .replace(/\b(couch( guy)?|buddy|bro|dude|man|mate|pal|again|please|pls)\b/g, '')
    .replace(/\?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.split(' ').length > 6) return null;
  // "hey, what's up": try the whole thing, then without the greeting in front.
  for (const v of [t, t.replace(/^(hey|hi|hello|yo|so|ok|okay) /, '')]) for (const x of TALK) if (x.re.test(v)) return x.say(now);
  return null;
}
