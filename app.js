/* ============================================================
   AdaptPractice — single-page learning environment
   Data lives in this browser (localStorage). AI answers come from
   Claude through the artifact runtime's `sample` capability.
   ============================================================ */

/* ---------- storage ---------- */
const KEY = 'adaptpractice.v1';
const blank = () => ({
  profile: null,
  courses: [],
  behaviour: { answers:0, correct:0, hints:0, explains:0, confusions:0, revisions:0, secs:0, modes:{} },
  events: [],
  settings: { theme:'light', focus:false }
});
let D = blank();
try { const raw = localStorage.getItem(KEY); if (raw) D = Object.assign(blank(), JSON.parse(raw)); } catch(e) {}
let saveWarned = false;
function save(){
  try { localStorage.setItem(KEY, JSON.stringify(D)); }
  catch(e){ if(!saveWarned){ saveWarned = true; toast('This browser blocked local storage. Your work stays only for this visit.'); } }
}
const uid = () => Math.random().toString(36).slice(2,10);
const PLACEHOLDER_BATCH = 15; // how many "Video N" slots a titleless playlist starts with
const now = () => Date.now();

/* ---------- small utils ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n,a,b) => Math.max(a, Math.min(b, n));
const pct = n => Math.round(n) + '%';
const mmss = s => { s = Math.max(0, Math.floor(s||0)); const m = Math.floor(s/60); return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); };
const parseTime = t => { const p = String(t||'').split(':').map(Number); if(p.some(isNaN)) return 0; return p.length===3 ? p[0]*3600+p[1]*60+p[2] : p.length===2 ? p[0]*60+p[1] : p[0]; };
const dayLabel = ts => new Date(ts).toLocaleDateString(undefined,{month:'short', day:'numeric'});
function toast(msg, ms){ const el = document.createElement('div'); el.className='toast'; el.textContent = msg; document.body.appendChild(el); setTimeout(()=>el.remove(), ms||3200); }
const GREEK = {times:'\u00d7', cdot:'\u00b7', div:'\u00f7', pm:'\u00b1', leq:'\u2264', le:'\u2264', geq:'\u2265', ge:'\u2265',
  neq:'\u2260', ne:'\u2260', approx:'\u2248', infty:'\u221e', alpha:'\u03b1', beta:'\u03b2', gamma:'\u03b3', delta:'\u03b4',
  epsilon:'\u03b5', theta:'\u03b8', lambda:'\u03bb', mu:'\u03bc', pi:'\u03c0', rho:'\u03c1', sigma:'\u03c3', phi:'\u03c6',
  omega:'\u03c9', Delta:'\u0394', Sigma:'\u03a3', Omega:'\u03a9', rightarrow:'\u2192', to:'\u2192', Rightarrow:'\u21d2',
  leftarrow:'\u2190', in:'\u2208', notin:'\u2209', subset:'\u2282', cup:'\u222a', cap:'\u2229', sum:'\u03a3', prod:'\u03a0',
  int:'\u222b', partial:'\u2202', nabla:'\u2207', forall:'\u2200', exists:'\u2203', therefore:'\u2234', circ:'\u00b0',
  degree:'\u00b0', ldots:'\u2026', dots:'\u2026', log:'log', ln:'ln', sin:'sin', cos:'cos', tan:'tan', max:'max', min:'min' };
const SUP = { '0':'\u2070','1':'\u00b9','2':'\u00b2','3':'\u00b3','4':'\u2074','5':'\u2075','6':'\u2076','7':'\u2077','8':'\u2078','9':'\u2079','+':'\u207a','-':'\u207b','n':'\u207f','i':'\u2071' };
const SUB = { '0':'\u2080','1':'\u2081','2':'\u2082','3':'\u2083','4':'\u2084','5':'\u2085','6':'\u2086','7':'\u2087','8':'\u2088','9':'\u2089','+':'\u208a','-':'\u208b','n':'\u2099','i':'\u1d62','j':'\u2c7c','k':'\u2096','x':'\u2093' };
const mapRun = (str, table, fallback) => [...str].every(ch => table[ch]) ? [...str].map(ch => table[ch]).join('') : fallback + (str.length > 1 ? '(' + str + ')' : str);
/* Models sometimes answer in LaTeX. Turn it into readable plain notation. */
function mathText(t){
  let s = String(t == null ? '' : t);
  if (!/[\\$^_]/.test(s)) return s;
  s = s.replace(/\\\[|\\\]|\\\(|\\\)/g, '');
  s = s.replace(/\$\$?([^$]*?)\$\$?/g, '$1');
  for (let i = 0; i < 3; i++){
    s = s.replace(/\\(?:d)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m,a,b) => '(' + a + ')/(' + b + ')');
  }
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (m,a) => '\u221a(' + a + ')');
  s = s.replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\(?:left|right)(?![A-Za-z])|\\!|\\,|\\;/g, '');
  s = s.replace(/\\([A-Za-z]+)/g, (m,k) => GREEK[k] !== undefined ? GREEK[k] : k);
  s = s.replace(/\^\s*\{([^{}]*)\}/g, (m,a) => mapRun(a, SUP, '^'));
  s = s.replace(/\^\s*(-?[A-Za-z0-9])/g, (m,a) => mapRun(a, SUP, '^'));
  s = s.replace(/_\s*\{([^{}]*)\}/g, (m,a) => mapRun(a, SUB, '_'));
  s = s.replace(/_\s*([A-Za-z0-9])/g, (m,a) => mapRun(a, SUB, '_'));
  return s;
}
function mdLite(t){
  t = mathText(t);
  return esc(t)
    .replace(/^### (.+)$/gm,'<h4>$1</h4>')
    .replace(/^## (.+)$/gm,'<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/^[-*] (.+)$/gm,'<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g,'<ul>$1</ul>')
    .replace(/\n{2,}/g,'</p><p>');
}

/* ---------- YouTube helpers ---------- */
function ytVideoId(u){
  const m = String(u||'').match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : (/^[A-Za-z0-9_-]{11}$/.test(String(u||'').trim()) ? u.trim() : null);
}
function ytListId(u){ const m = String(u||'').match(/[?&]list=([A-Za-z0-9_-]+)/); return m ? m[1] : null; }

function cleanPlaylistPaste(raw){
  const lines = String(raw||'').split(/\r?\n/).map(s => s.trim());
  const noise = [
    /^\d{1,2}:\d{2}(:\d{2})?$/,
    /^\d[\d,.]*\s*[KMB]?\+?\s*(views?|watching)$/i,
    /^\d[\d,.]*\s*[KMB]?\+?\s*subscribers?$/i,
    /^[•·|·⋅]+$/,
    /^\d+\s*(second|minute|hour|day|week|month|year)s?\s*ago$/i,
    /^(mix|playlist|live now|live|new|shorts|premieres.*|scheduled.*)$/i,
    /^\d+$/
  ];
  const out = [];
  for (const l of lines){
    if (!l || l.length < 2) continue;
    if (noise.some(re => re.test(l))) continue;
    const parts = l.split(/\s*[•·⋅]\s*/).map(p => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(p => noise.some(re => re.test(p)))) continue;
    out.push(l);
  }
  return out;
}
let ytTime = 0, ytPoll = null, ytAlive = false;
window.addEventListener('message', ev => {
  if (!/youtube(-nocookie)?\.com$/.test(String(ev.origin).replace(/^https?:\/\/(www\.)?/,''))) return;
  try { const d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
    if (d && d.info && typeof d.info.currentTime === 'number') ytTime = d.info.currentTime;
    if (d && (d.info || d.event)){ ytAlive = true; const n = document.getElementById('playnote'); if (n) n.classList.add('live'); }
    if (d && d.info && d.info.videoData && d.info.videoData.title) captureAutoTitle(d.info.videoData.title, d.info.videoData.video_id);
  } catch(e){}
});
function captureAutoTitle(title, videoId){
  if (S.view !== 'lesson' || !S.course || !S.lesson) return;
  const c = getCourse(S.course); if (!c) return;
  const r = rawLesson(c, S.lesson); if (!r) return;
  const lesson = r.lesson;
  const src = r.src;
  let changed = false;

  if (lesson.auto && title){
    const clean = String(title).trim();
    if (clean){ lesson.title = clean; lesson.auto = false; changed = true; }
  }
  if (src && src.type !== 'playlist' && videoId && !lesson.url){
    lesson.url = 'https://www.youtube.com/watch?v=' + videoId;
    changed = true;
  }
  if (!changed) return;

  save();
  const t1 = document.querySelector('[data-role="lesson-title"]'); if (t1) t1.textContent = lesson.title;
  document.querySelectorAll('[data-lesson-li="'+lesson.id+'"] .lbl').forEach(el => { el.textContent = lesson.title; });
}
function ytHandshake(){
  clearInterval(ytPoll);
  ytAlive = false;
  ytPoll = setInterval(() => {
    const f = document.getElementById('ytframe');
    if (!f || !f.contentWindow) return;
    try { f.contentWindow.postMessage(JSON.stringify({event:'listening', id:1, channel:'widget'}), '*'); } catch(e){}
  }, 1000);
}

const API_BASE = (window.ADAPTPRACTICE_API_BASE || window.location.origin || '').replace(/\/$/, '');
let SAMPLE = false, aiChecked = false, booted = false;
function getAuthHeaders() {
  const key = (localStorage.getItem('adaptpractice_api_key') || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-api-key'] = key;
  return headers;
}
(async () => {
  try {
    const res = await fetch((API_BASE || window.location.origin) + '/api/health');
    const health = res.ok ? await res.json() : {};
    const userKey = (localStorage.getItem('adaptpractice_api_key') || '').trim();
    SAMPLE = (health && health.ok === true) || Boolean(userKey);
  } catch (e) {
    SAMPLE = Boolean((localStorage.getItem('adaptpractice_api_key') || '').trim());
  }
  aiChecked = true;
  if (booted) render();
})();
async function fetchPlaylistItems(url){
  const listUrl = encodeURIComponent(String(url || '').trim());
  if (!listUrl) throw new Error('No playlist URL supplied.');
  const res = await fetch(API_BASE + '/api/playlist?url=' + listUrl);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not load the playlist.');
  }
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

const AI_COPY = {
  not_granted:'The AI backend is not reachable. You can provide an Anthropic or Gemini API key in Profile to activate AI features.',
  missing_api_key:'No AI API key is configured. Add your API key in Profile or set it in your hosting environment.',
  sampling_disabled:'AI is not available on this account.',
  not_declared:'This page no longer has AI access.',
  capability_disabled:'AI is unavailable in this view.',
  capability_removed:'AI is unavailable in this view.',
  rate_limited:'Too many AI requests. Wait a minute and try again.',
  credits_exhausted:'Your Anthropic API account has no available credit. Add credit in Anthropic Console → Plans & Billing, then retry.',
  invalid_api_key:'The API key was rejected. Please check your API key in Profile.',
  invalid_model:'The configured AI model is unavailable.',
  provider_overloaded:'The AI provider is temporarily overloaded. Please retry in a moment.',
  session_expired:'Sign in to your AI provider again, then retry.',
  refused:'The AI model declined this request. Try rephrasing your source or question.',
  empty_completion:'The AI model returned nothing. Ask for a smaller piece at a time.',
  invalid_json:'The AI model returned a malformed answer. Try again.',
  prompt_too_large:'That source is too long. Use a shorter excerpt.',
  cancelled:'Stopped.',
  upstream_error:'The AI request failed. Try again.'
};
const aiErr = e => AI_COPY[e && e.code] || (e && e.message) || AI_COPY.upstream_error;
function aiAvailable(){ return !!SAMPLE; }

async function ask(input, opts){
  opts = opts || {};
  if (!SAMPLE) throw { code:'not_granted', message:'backend unreachable' };
  if (!opts.onText) {
    const res = await fetch(API_BASE + '/api/ai/text', { method:'POST', headers: getAuthHeaders(), body: JSON.stringify({ prompt: input }) });
    if (!res.ok) throw await backendError(res);
    const data = await res.json();
    return { text: data.text || '' };
  }
  return new Promise((resolve, reject) => {
    fetch(API_BASE + '/api/ai/stream', { method:'POST', headers: getAuthHeaders(), body: JSON.stringify({ prompt: input }) })
      .then(async res => {
        if (!res.ok || !res.body) return reject(await backendError(res));
        const reader = res.body.getReader(); const decoder = new TextDecoder();
        let full = '', buf = '';
        while (true){
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream:true });
          const lines = buf.split('\n\n'); buf = lines.pop();
          for (const line of lines){
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') { resolve({ text: full }); return; }
            try {
              const j = JSON.parse(payload);
              if (j.delta) { full += j.delta; opts.onText({ text: full }); }
              if (j.error) { reject({ code:'upstream_error', message:j.error }); return; }
            } catch(e) {}
          }
        }
        resolve({ text: full });
      }).catch(err => reject({ code:'upstream_error', message: String(err && err.message || err) }));
  });
}
async function askJson(input, opts){
  if (!SAMPLE) throw { code:'not_granted', message:'backend unreachable' };
  const res = await fetch(API_BASE + '/api/ai/json', { method:'POST', headers: getAuthHeaders(), body: JSON.stringify({ prompt: input }) });
  if (!res.ok) throw await backendError(res);
  return res.json();
}
async function backendError(res){
  let code = 'upstream_error', message = 'Request failed (' + res.status + ')';
  try { const j = await res.json(); if (j && j.error) message = j.error; if (j && j.code) code = j.code; if (res.status === 429) code = 'rate_limited'; if (res.status === 413) code = 'prompt_too_large'; }
  catch(e) {}
  return { code, message };
}

function ev(type, payload){
  const e = Object.assign({ id:uid(), t:now(), type }, payload||{});
  D.events.unshift(e);
  if (D.events.length > 600) D.events.length = 600;
  save();
  return e;
}

function conceptOf(course, name){
  const k = String(name||'General').trim();
  if (!course.concepts[k]) course.concepts[k] = {
    name:k, mastery:35, attempts:0, correct:0, errors:0, hints:0, confusion:0,
    status:'new', source:null, lastSeen:0, history:[], errorTypes:{}
  };
  return course.concepts[k];
}
function recordAttempt(course, name, res){
  const c = conceptOf(course, name);
  c.attempts++; c.lastSeen = now();
  if (res.hint) c.hints++;
  const m = c.mastery;
  if (res.verdict === 'correct'){ c.correct++; c.mastery = m + (res.hint ? (80-m)*0.14 : (94-m)*0.30); }
  else if (res.verdict === 'partial'){ c.errors += 0.5; c.mastery = m + (68-m)*0.10; }
  else { c.errors++; c.mastery = Math.max(3, m*0.78 - 2); }
  c.mastery = clamp(Math.round(c.mastery), 0, 100);
  if (res.errorType && res.verdict !== 'correct') c.errorTypes[res.errorType] = (c.errorTypes[res.errorType]||0) + 1;
  if (res.source) c.source = res.source;
  c.history.push({ t:now(), v:res.verdict, m:c.mastery, d:res.difficulty||'medium' });
  if (c.history.length > 40) c.history.shift();
  restatus(c);
  return c;
}
function restatus(c){
  const prev = c.status;
  if (c.attempts >= 3 && c.errors >= 2 && c.mastery < 65) c.status = 'weakness';
  else if (c.errors >= 1 && c.mastery < 70) c.status = 'watch';
  else if (c.attempts >= 4 && c.mastery >= 82 && c.errors <= 1) c.status = 'mastered';
  else if (c.attempts >= 2 && c.mastery >= 70) c.status = 'improving';
  else c.status = c.attempts ? 'learning' : 'new';
  return prev !== c.status;
}
function priority(c){
  let p = (100 - c.mastery) * 0.6 + c.errors * 7 + c.confusion * 6;
  if (c.status === 'weakness') p += 18;
  if (c.status === 'mastered') p -= 40;
  const ageDays = (now() - (c.lastSeen||now())) / 864e5;
  p += clamp(ageDays * 1.5, 0, 12);
  return Math.round(p);
}
const prioBand = p => p >= 58 ? 'high' : p >= 36 ? 'medium' : 'low';
function conceptList(course){ return Object.values(course.concepts||{}); }
function weakList(course){
  return conceptList(course)
    .filter(c => c.attempts > 0 || c.confusion > 0)
    .sort((a,b) => priority(b) - priority(a));
}
function courseProgress(course){
  const lessons = allLessons(course);
  const done = lessons.filter(l => l.done).length;
  const cs = conceptList(course).filter(c => c.attempts > 0);
  const mastery = cs.length ? Math.round(cs.reduce((s,c)=>s+c.mastery,0)/cs.length) : 0;
  return { done, total: lessons.length, coverage: lessons.length ? Math.round(done/lessons.length*100) : 0, mastery, tracked: cs.length };
}
function allLessons(course){
  const out = [];
  (course.sources||[]).forEach(s => (s.lessons||[]).forEach(l => out.push(Object.assign({ sourceId:s.id, sourceTitle:s.title, sourceType:s.type }, l))));
  return out;
}
function findLesson(course, id){ return allLessons(course).find(l => l.id === id); }
function rawLesson(course, id){
  for (const s of course.sources||[]) { const l = (s.lessons||[]).find(x => x.id === id); if (l) return { src:s, lesson:l }; }
  return null;
}
const getCourse = id => D.courses.find(c => c.id === id);

const S = { view:'landing', course:null, lesson:null, work:null, busy:'', modal:null, wizard:null, session:null };
function go(view, patch){
  Object.assign(S, patch||{});
  S.view = view;
  window.scrollTo(0,0);
  render();
}
function boot(){
  booted = true;
  if (!D.profile) { S.view = 'landing'; }
  else S.view = 'dash';
  applyTheme();
  render();
}
function applyTheme(){ document.documentElement.setAttribute('data-theme', D.settings.theme || 'light'); }

function render(){
  const app = $('#app');
  if (S.view === 'landing'){ app.innerHTML = vLanding(); return; }
  if (S.view === 'onboard'){ app.innerHTML = vOnboard(); return; }
  if (S.view === 'lesson'){ app.innerHTML = vLesson(); ytHandshake(); return; }
  const f = D.settings.focus;
  app.innerHTML = '<div class="shell' + (f?' focus':'') + '">' + (f ? '' : rail()) + '<main class="main">' + (f ? focusExit() : '') + body() + '</div></div>';
}

// ... (Rest of render and views) ...
// Since the file is too large for a single cat, I'm keeping the structure and only modifying the requested function.

async function buildFromWizard(){
  const w = S.wizard; 
  grabSource();
  
  // 4. Input Sanity Check (Client-side)
  if (w.srcType !== 'pdf' && !w.url && !w.titles && !w.text){ 
    toast('Add a link, some titles, or the text.'); 
    return; 
  }
  if (w.srcType === 'pdf' && !w.text){ 
    toast('Load a PDF or paste its text.'); 
    return; 
  }

  // Validate API key state before starting
  const userKey = (localStorage.getItem('adaptpractice_api_key') || '').trim();
  if (!userKey && !aiAvailable()) {
    toast('Please provide an API key in Profile to activate AI features.');
    return;
  }

  if (w.srcType === 'playlist' && w.url && !w.titles) {
    try {
      const items = await fetchPlaylistItems(w.url);
      if (items.length){
        w.titles = items.map(item => item.title).filter(Boolean).join('\n');
      }
    } catch (e) {
      console.warn('Playlist title import failed:', e && e.message ? e.message : e);
    }
  }

  if (!SAMPLE){
    const titles = (w.titles||'').split('\n').map(s=>s.trim()).filter(Boolean);
    let lessons;
    if (w.srcType === 'pdf') lessons = [{ title: w.fileName || 'Document', concepts:[] }];
    else if (w.srcType === 'video') lessons = [{ title: w.name + ' — lesson 1', concepts:[] }];
    else if (titles.length) lessons = titles.map(t => ({ title:t, concepts:[] }));
    else lessons = [];
    finishCourse(w, { lessons, roadmap:[], gap:'' });
    return;
  }
  await guard(async () => {
    const out = await buildCourse(w);
    finishCourse(w, out);
  }, 'Reading your material…');
}
// ... (rest of the file remains unchanged) ...
