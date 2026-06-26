/* =========================================================
 * 生词本 PWA - 核心逻辑 (v1.1 修复版)
 * 修复:超时中断、防抖、定时器管理、数据备份、算法优化、分页、无障碍
 * ========================================================= */

// ========== 全局状态 ==========
const STATE = {
  words: [],
  settings: {
    reminderOn: false,
    reminderTime: '20:00',
    rate: 0.8,
    repeat: 2,
    pauseSec: 3,
    autoStop: true,
    readExample: true,
    intervals: [1, 2, 4, 7, 15, 30],
    masterCount: 5
  },
  reviewQueue: [],
  reviewIdx: 0,
  cardFlipped: false,
  drive: {
    playing: false,
    queue: [],
    idx: 0,
    autoStopTimer: null,
    voiceOn: false,
    recognition: null
  },
  timers: [],
  domCache: {}
};

// ========== 持久化 ==========
const STORAGE_KEY = 'vocab_app_data_v1';
function saveAll() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    words: STATE.words,
    settings: STATE.settings
  }));
}
function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.words) STATE.words = data.words;
    if (data.settings) STATE.settings = { ...STATE.settings, ...data.settings };
  } catch (e) {
    const bad = localStorage.getItem(STORAGE_KEY);
    if (bad) localStorage.setItem(STORAGE_KEY + '_backup_err', bad);
    toast('本地词库数据损坏，已备份，请导入备份恢复');
    console.error('数据解析失败，备份已保存', e);
  }
}

// ========== 工具 ==========
const $ = (sel) => {
  if (!STATE.domCache[sel]) STATE.domCache[sel] = document.querySelector(sel);
  return STATE.domCache[sel];
};
const $$ = (sel) => document.querySelectorAll(sel);
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function nowMs() { return Date.now(); }
function toast(msg, dur = 1800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, dur);
}

// 防抖
function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// 定时器统一管理
function regTimer(t) { STATE.timers.push(t); return t; }
function clearAllTimers() {
  STATE.timers.forEach(t => clearTimeout(t));
  STATE.timers = [];
  clearTimeout(STATE.drive.autoStopTimer);
  STATE.drive.autoStopTimer = null;
}

// ========== 路由 ==========
function showPage(id) {
  // 离开开车页时清理资源
  if (!document.querySelector('#page-drive.active') && id !== 'drive') {
    driveCleanup();
  }
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $('#page-' + id);
  if (target) target.classList.add('active');
  window.scrollTo(0, 0);
}

// ========== 首页 ==========
function refreshHome() {
  const total = STATE.words.length;
  const due = computeDueWords().length;
  const mastered = STATE.words.filter(w => w.mastered).length;
  $('#statTotal').textContent = total;
  $('#statDue').textContent = due;
  $('#statMastered').textContent = mastered;
  $('#reviewBadge').textContent = due;
  $('#reviewBadge').style.display = due > 0 ? 'inline-block' : 'none';

  const h = new Date().getHours();
  const greet = h < 6 ? '深夜也在学习,辛苦了 🌙'
              : h < 12 ? '早上好,继续加油 💪'
              : h < 14 ? '中午好,小憩后再战 ☀️'
              : h < 18 ? '下午好,劳逸结合 📖'
              : '晚上好,温故而知新 🌟';
  $('#greeting').textContent = greet;
}

// ========== 复习计算 ==========
function computeDueWords() {
  const now = nowMs();
  return STATE.words.filter(w => !w.mastered && (!w.nextReviewAt || w.nextReviewAt <= now));
}

function scheduleNextReview(word, quality) {
  const intervals = STATE.settings.intervals;
  if (quality === 'master') {
    word.mastered = true;
    word.masteredAt = nowMs();
    return;
  }
  if (quality === 'forget') {
    word.correctStreak = 0;
    // 遗忘后缩短间隔，从第1个间隔重新开始
    word.nextReviewAt = nowMs() + (intervals[0] || 1) * 24 * 60 * 60 * 1000;
  } else if (quality === 'hard') {
    // 有点印象：保持当前层级但缩短一半间隔，不重置streak
    const idx = Math.min(word.correctStreak || 0, intervals.length - 1);
    const halfInterval = Math.max(1, Math.floor((intervals[idx] || 1) / 2));
    word.nextReviewAt = nowMs() + halfInterval * 24 * 60 * 60 * 1000;
  } else if (quality === 'good') {
    word.correctStreak = (word.correctStreak || 0) + 1;
    const idx = Math.min(word.correctStreak - 1, intervals.length - 1);
    word.nextReviewAt = nowMs() + intervals[idx] * 24 * 60 * 60 * 1000;
    if (word.correctStreak >= STATE.settings.masterCount) {
      word.mastered = true;
      word.masteredAt = nowMs();
    }
  }
  word.reviewCount = (word.reviewCount || 0) + 1;
}

// ========== 词典 API(带超时) ==========
async function lookupWord(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase().trim())}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('not found');
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) throw new Error('empty');
    const entry = data[0];
    let phonetic = entry.phonetic || (entry.phonetics?.find(p => p.text)?.text) || '';
    const meanings = (entry.meanings || []).map(m => ({
      pos: m.partOfSpeech,
      defs: (m.definitions || []).slice(0, 2).map(d => d.definition)
    }));
    const example = entry.meanings?.flatMap(m => m.definitions || []).find(d => d.example)?.example || '';
    return { ok: true, word: entry.word || word, phonetic, meanings, example };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') return { ok: false, error: '查询超时，请检查网络' };
    return { ok: false, error: e.message };
  }
}

// 中文翻译(带超时+缓存)
const _transCache = {};
async function translateToChinese(text) {
  if (_transCache[text]) return _transCache[text];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('translate failed');
    const data = await res.json();
    const result = data?.[0]?.map(seg => seg[0]).join('') || '';
    if (result) _transCache[text] = result;
    return result;
  } catch {
    clearTimeout(timeout);
    return '';
  }
}

// ========== TTS 朗读 ==========
let speakReady = false;
function initTTS() {
  if ('speechSynthesis' in window) {
    const voices = speechSynthesis.getVoices();
    if (voices.length) speakReady = true;
    speechSynthesis.addEventListener('voiceschanged', () => { speakReady = true; });
  }
}
function speak(text, opts = {}) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window) || !text) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = opts.lang || 'en-US';
    u.rate = opts.rate ?? 1;
    u.pitch = opts.pitch ?? 1;
    u.volume = opts.volume ?? 1;
    const voices = speechSynthesis.getVoices();
    const isZh = u.lang.startsWith('zh');
    const v = voices.find(v => isZh ? v.lang.startsWith('zh') : v.lang.startsWith('en'));
    if (v) u.voice = v;
    // 找不到对应语言语音时使用默认，不静默失败
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}
function stopSpeak() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ========== 录入页 ==========
async function handleLookup() {
  const w = $('#wordInput').value.trim();
  if (!w) { toast('请输入单词'); return; }
  const btn = $('#lookupBtn');
  if (btn.disabled) return;
  btn.textContent = '查询中…'; btn.disabled = true;

  const result = await lookupWord(w);
  $('#lookupResult').hidden = false;
  $('#customFields').hidden = false;

  if (result.ok) {
    const meaningsHtml = result.meanings.map(m =>
      `<div class="lr-def"><span class="lr-pos">${m.pos || ''}</span>${m.defs.join('; ')}</div>`
    ).join('');
    $('#lookupResult').innerHTML = `
      <div class="lr-word">${result.word}</div>
      <div class="lr-phon">${result.phonetic || ''}</div>
      ${meaningsHtml}
      ${result.example ? `<div class="lr-example">"${result.example}"</div>` : ''}
      <button class="lr-speak" data-tts-word="${escapeHtml(result.word)}">🔊 试听</button>
    `;
    const englishMeanings = result.meanings.flatMap(m => m.defs).slice(0, 2).join('; ');
    let zh = '';
    if (englishMeanings) zh = await translateToChinese(englishMeanings);
    $('#meaningInput').value = zh || englishMeanings;
    $('#exampleInput').value = result.example || '';
    $('#wordInput').dataset.phonetic = result.phonetic || '';
    $('#wordInput').dataset.realword = result.word;
  } else {
    $('#lookupResult').innerHTML = `<div style="color:#fca5a5">⚠️ ${result.error === 'not found' ? '词典未收录此单词' : result.error}，你可以手动填写释义后保存</div>`;
    $('#meaningInput').value = '';
    $('#exampleInput').value = '';
    $('#wordInput').dataset.phonetic = '';
    $('#wordInput').dataset.realword = w;
  }
  btn.textContent = '查询'; btn.disabled = false;
}

function handleSaveWord() {
  const btn = $('#saveWordBtn');
  if (btn.disabled) return;
  btn.disabled = true;

  const word = ($('#wordInput').dataset.realword || $('#wordInput').value).trim();
  const meaning = $('#meaningInput').value.trim();
  if (!word) { toast('请输入单词'); btn.disabled = false; return; }
  if (!meaning) { toast('请填写释义'); btn.disabled = false; return; }

  const exists = STATE.words.find(w => w.word.toLowerCase() === word.toLowerCase());
  if (exists) {
    if (!confirm(`词库中已有 "${word}",是否覆盖更新?`)) { btn.disabled = false; return; }
    // 只更新内容字段，保留复习进度数据
    exists.meaning = meaning;
    exists.example = $('#exampleInput').value.trim();
    exists.note = $('#noteInput').value.trim();
    if ($('#wordInput').dataset.phonetic) exists.phonetic = $('#wordInput').dataset.phonetic;
  } else {
    STATE.words.push({
      id: uid(), word,
      phonetic: $('#wordInput').dataset.phonetic || '',
      meaning, example: $('#exampleInput').value.trim(),
      note: $('#noteInput').value.trim(),
      createdAt: nowMs(), reviewCount: 0, correctStreak: 0,
      nextReviewAt: nowMs(), mastered: false
    });
  }
  saveAll();
  toast(exists ? '已更新 ✓' : '已加入词库 ✓');
  $('#wordInput').value = '';
  $('#meaningInput').value = '';
  $('#exampleInput').value = '';
  $('#noteInput').value = '';
  $('#lookupResult').hidden = true;
  $('#customFields').hidden = true;
  refreshHome();
  btn.disabled = false;
}

// ========== 词库页(分页) ==========
let libTab = 'all';
const PAGE_SIZE = 50;
let libPage = 1;

function refreshLib() {
  const all = STATE.words;
  const learning = all.filter(w => !w.mastered);
  const mastered = all.filter(w => w.mastered);
  $('#tabAllCount').textContent = all.length;
  $('#tabLearningCount').textContent = learning.length;
  $('#tabMasteredCount').textContent = mastered.length;

  let list = libTab === 'learning' ? learning : libTab === 'mastered' ? mastered : all;
  const q = $('#searchInput').value.trim().toLowerCase();
  if (q) list = list.filter(w => w.word.toLowerCase().includes(q) || (w.meaning || '').toLowerCase().includes(q));
  list = list.slice().sort((a, b) => b.createdAt - a.createdAt);

  const el = $('#libList');
  if (list.length === 0) {
    el.innerHTML = `<div class="empty-list"><div class="ei">📭</div>暂无单词,去录入第一个吧</div>`;
    return;
  }

  // 分页
  const totalPages = Math.ceil(list.length / PAGE_SIZE);
  const start = (libPage - 1) * PAGE_SIZE;
  const pageList = list.slice(start, start + PAGE_SIZE);

  const frag = document.createDocumentFragment();
  pageList.forEach(w => {
    const isDue = !w.mastered && (!w.nextReviewAt || w.nextReviewAt <= nowMs());
    const status = w.mastered ? '<span class="wi-status mastered">已掌握</span>'
                  : isDue ? '<span class="wi-status due">待复习</span>'
                  : '<span class="wi-status">学习中</span>';
    const div = document.createElement('div');
    div.className = 'word-item';
    div.dataset.id = w.id;
    div.innerHTML = `
      <div class="wi-main">
        <div><span class="wi-word">${escapeHtml(w.word)}</span><span class="wi-phon">${escapeHtml(w.phonetic || '')}</span></div>
        <div class="wi-meaning">${escapeHtml(w.meaning || '')}</div>
      </div>
      ${status}
      <div class="wi-actions">
        <button data-action="speak" title="朗读" aria-label="朗读">🔊</button>
        ${w.mastered
          ? '<button data-action="restore" title="移回学习中" aria-label="移回学习中">↩️</button>'
          : '<button data-action="master" title="标记为已掌握" aria-label="标记为已掌握">✓</button>'}
        <button data-action="delete" title="删除" aria-label="删除">🗑</button>
      </div>
    `;
    frag.appendChild(div);
  });
  el.innerHTML = '';
  el.appendChild(frag);

  // 分页按钮
  if (totalPages > 1) {
    const pager = document.createElement('div');
    pager.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:12px;';
    pager.innerHTML = `
      <button class="text-btn" ${libPage <= 1 ? 'disabled' : ''} data-page="prev">‹ 上一页</button>
      <span style="color:#94a3b8;font-size:13px;line-height:32px;">${libPage} / ${totalPages}</span>
      <button class="text-btn" ${libPage >= totalPages ? 'disabled' : ''} data-page="next">下一页 ›</button>
    `;
    el.appendChild(pager);
  }
}
function escapeHtml(s) { return (s || '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c])); }

function handleLibAction(e) {
  const btn = e.target.closest('button[data-action], button[data-page]');
  if (!btn) return;
  const item = btn.closest('.word-item');
  const id = item?.dataset.id;
  const word = id ? STATE.words.find(w => w.id === id) : null;

  const action = btn.dataset.action;
  if (action === 'speak') { speak(word.word, { rate: STATE.settings.rate }); }
  else if (action === 'master') {
    word.mastered = true; word.masteredAt = nowMs();
    saveAll(); refreshLib(); refreshHome(); toast('已标记为掌握 🎯');
  }
  else if (action === 'restore') {
    word.mastered = false; word.masteredAt = null; word.correctStreak = 0;
    word.nextReviewAt = nowMs();
    saveAll(); refreshLib(); refreshHome(); toast('已移回学习中');
  }
  else if (action === 'delete') {
    if (!confirm(`确定删除 "${word.word}" 吗?`)) return;
    STATE.words = STATE.words.filter(w => w.id !== id);
    saveAll(); refreshLib(); refreshHome(); toast('已删除');
  }

  const pageAction = btn.dataset.page;
  if (pageAction === 'prev') { libPage = Math.max(1, libPage - 1); refreshLib(); }
  else if (pageAction === 'next') { libPage++; refreshLib(); }
}

// ========== 卡片复习 ==========
function startReview() {
  STATE.reviewQueue = computeDueWords().slice().sort(() => Math.random() - 0.5);
  STATE.reviewIdx = 0;
  showPage('review');
  renderReviewCard();
}
function renderReviewCard() {
  const q = STATE.reviewQueue;
  const i = STATE.reviewIdx;
  $('#reviewProgress').textContent = `${Math.min(i + 1, q.length)} / ${q.length}`;
  if (i >= q.length || q.length === 0) {
    $('#flashCard').hidden = true;
    $('#reviewActions').hidden = true;
    $('#reviewEmpty').hidden = false;
    return;
  }
  $('#reviewEmpty').hidden = true;
  $('#flashCard').hidden = false;
  $('#reviewActions').hidden = false;
  const w = q[i];
  $('#cardWord').textContent = w.word;
  $('#cardPhon').textContent = w.phonetic || '';
  $('#cardMeaning').textContent = w.meaning || '';
  $('#cardExample').textContent = w.example || '';
  $('#flashCard').classList.remove('flipped');
  STATE.cardFlipped = false;
  setTimeout(() => speak(w.word, { rate: STATE.settings.rate }), 200);
}
function flipCard() {
  STATE.cardFlipped = !STATE.cardFlipped;
  $('#flashCard').classList.toggle('flipped', STATE.cardFlipped);
}
function reviewAnswer(quality) {
  const w = STATE.reviewQueue[STATE.reviewIdx];
  if (!w) return;
  scheduleNextReview(w, quality);
  saveAll();
  if (quality === 'master') toast('已掌握,移出复习库 🎯');
  STATE.reviewIdx++;
  renderReviewCard();
  refreshHome();
}

// ========== 开车听学模式 ==========
function buildDriveQueue() {
  const due = computeDueWords();
  const learning = STATE.words.filter(w => !w.mastered && !due.includes(w));
  let queue = [...due, ...learning];
  if (queue.length === 0) queue = STATE.words.filter(w => !w.mastered);
  return queue.slice().sort(() => Math.random() - 0.5);
}

async function drivePlay() {
  const D = STATE.drive;
  if (D.queue.length === 0) { D.queue = buildDriveQueue(); D.idx = 0; }
  if (D.queue.length === 0) { toast('词库还没有单词,先录入一些吧'); return; }
  D.playing = true;
  $('#drivePlayBtn').textContent = '⏸';
  $('#driveRing').classList.add('playing');

  if (STATE.settings.autoStop) {
    clearTimeout(D.autoStopTimer);
    D.autoStopTimer = regTimer(setTimeout(() => {
      drivePause();
      speak('听学模式已自动暂停,请注意休息', { lang: 'zh-CN' });
      toast('15 分钟到,已自动暂停');
    }, 15 * 60 * 1000));
  }

  if (D.idx === 0) {
    await speak('5 秒后开始,请专注道路', { lang: 'zh-CN', rate: 1 });
    await wait(1000);
  }

  while (D.playing && D.idx < D.queue.length) {
    const w = D.queue[D.idx];
    renderDriveWord(w);
    for (let r = 0; r < STATE.settings.repeat; r++) {
      if (!D.playing) return;
      await speak(w.word, { rate: STATE.settings.rate });
      await wait(600);
    }
    if (!D.playing) return;
    await speak(w.meaning, { lang: 'zh-CN', rate: 1 });
    if (!D.playing) return;
    if (STATE.settings.readExample && w.example) {
      await wait(400);
      await speak(w.example, { rate: STATE.settings.rate });
    }
    if (!D.playing) return;
    await wait(STATE.settings.pauseSec * 1000);
    D.idx++;
  }
  if (D.idx >= D.queue.length) {
    await speak('本轮听学已完成,马上进入下一轮', { lang: 'zh-CN' });
    D.idx = 0; D.queue = buildDriveQueue();
    if (D.playing) drivePlay();
  }
}

function drivePause() {
  STATE.drive.playing = false;
  stopSpeak();
  // 暂停时同步关闭语音识别，避免后台耗电
  const D = STATE.drive;
  if (D.voiceOn && D.recognition) {
    D.voiceOn = false;
    try { D.recognition.stop(); } catch {}
    D.recognition = null;
    $('#driveVoiceBtn').textContent = '🎙️ 语音控制:关';
    $('#driveVoiceBtn').classList.remove('active');
  }
  $('#drivePlayBtn').textContent = '▶';
  $('#driveRing').classList.remove('playing');
  clearTimeout(STATE.drive.autoStopTimer);
  STATE.drive.autoStopTimer = null;
}

function driveCleanup() {
  drivePause();
  const D = STATE.drive;
  D.voiceOn = false;
  if (D.recognition) { try { D.recognition.stop(); } catch {} D.recognition = null; }
  $('#driveVoiceBtn').textContent = '🎙️ 语音控制:关';
  $('#driveVoiceBtn').classList.remove('active');
  clearAllTimers();
}

function driveNext() {
  stopSpeak();
  STATE.drive.idx++;
  if (STATE.drive.playing) {
    STATE.drive.playing = false;
    setTimeout(() => { STATE.drive.playing = true; drivePlay(); }, 200);
  } else {
    const w = STATE.drive.queue[STATE.drive.idx];
    if (w) renderDriveWord(w);
  }
}
function drivePrev() {
  stopSpeak();
  STATE.drive.idx = Math.max(0, STATE.drive.idx - 1);
  if (STATE.drive.playing) {
    STATE.drive.playing = false;
    setTimeout(() => { STATE.drive.playing = true; drivePlay(); }, 200);
  } else {
    const w = STATE.drive.queue[STATE.drive.idx];
    if (w) renderDriveWord(w);
  }
}
function driveRepeat() {
  stopSpeak();
  if (STATE.drive.playing) {
    STATE.drive.playing = false;
    setTimeout(() => { STATE.drive.playing = true; drivePlay(); }, 200);
  } else {
    const w = STATE.drive.queue[STATE.drive.idx];
    if (w) { renderDriveWord(w); speak(w.word, { rate: STATE.settings.rate }); }
  }
}
function renderDriveWord(w) {
  $('#driveWord').textContent = w.word;
  $('#drivePhon').textContent = w.phonetic || '';
  $('#driveMeaning').textContent = w.meaning || '';
  $('#driveProgress').textContent = `${STATE.drive.idx + 1} / ${STATE.drive.queue.length}`;
}

// ========== 语音控制 ==========
function toggleVoiceControl() {
  const D = STATE.drive;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('当前浏览器不支持语音识别,请用 Chrome / Edge'); return; }
  if (D.voiceOn) {
    D.voiceOn = false;
    if (D.recognition) { try { D.recognition.stop(); } catch {} D.recognition = null; }
    $('#driveVoiceBtn').textContent = '🎙️ 语音控制:关';
    $('#driveVoiceBtn').classList.remove('active');
    return;
  }
  const rec = new SR();
  rec.lang = 'zh-CN'; rec.continuous = true; rec.interimResults = false;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      handleVoiceCommand(e.results[i][0].transcript.trim());
    }
  };
  rec.onerror = (e) => { console.warn('语音识别错误', e.error); };
  rec.onend = () => { if (D.voiceOn && D.recognition === rec) try { rec.start(); } catch {} };
  try { rec.start(); } catch (e) { toast('语音控制启动失败'); return; }
  D.recognition = rec; D.voiceOn = true;
  $('#driveVoiceBtn').textContent = '🎙️ 语音控制:开';
  $('#driveVoiceBtn').classList.add('active');
  toast('语音控制已开启,可说"重复/下一个/暂停/继续"');
}
function handleVoiceCommand(text) {
  const t = text.toLowerCase();
  if (/重复|再说|再来/.test(t)) driveRepeat();
  else if (/下一|下个|next/.test(t)) driveNext();
  else if (/上一|上个|prev/.test(t)) drivePrev();
  else if (/暂停|停一下|pause|停止/.test(t)) drivePause();
  else if (/继续|开始|播放|play/.test(t)) { if (!STATE.drive.playing) drivePlay(); }
}

// ========== 提醒 ==========
async function setupReminder() {
  if (!STATE.settings.reminderOn) return;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  scheduleDailyReminder();
}
let reminderTimer = null;
function scheduleDailyReminder() {
  clearTimeout(reminderTimer);
  if (!STATE.settings.reminderOn) return;
  const [hh, mm] = STATE.settings.reminderTime.split(':').map(Number);
  const now = new Date(), next = new Date();
  next.setHours(hh, mm, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  reminderTimer = regTimer(setTimeout(() => {
    const due = computeDueWords().length;
    if (due > 0) sendNotification('生词本提醒', `今天有 ${due} 个单词等你复习哦~`);
    scheduleDailyReminder();
  }, next - now));
}
function sendNotification(title, body) {
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'SHOW_NOTIFICATION', title, body });
  } else if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

// ========== 设置 ==========
function bindSettings() {
  $('#setReminderOn').checked = STATE.settings.reminderOn;
  $('#setReminderTime').value = STATE.settings.reminderTime;
  $('#setRate').value = STATE.settings.rate;
  $('#rateVal').textContent = STATE.settings.rate + 'x';
  $('#setRepeat').value = STATE.settings.repeat;
  $('#setPause').value = STATE.settings.pauseSec;
  $('#setAutoStop').checked = STATE.settings.autoStop;
  $('#setReadExample').checked = STATE.settings.readExample;
  $('#setIntervals').value = STATE.settings.intervals.join(',');
  $('#setMasterCount').value = STATE.settings.masterCount;

  $('#setReminderOn').onchange = async (e) => {
    STATE.settings.reminderOn = e.target.checked; saveAll();
    if (e.target.checked) await setupReminder();
    else clearTimeout(reminderTimer);
  };
  $('#setReminderTime').onchange = (e) => { STATE.settings.reminderTime = e.target.value; saveAll(); scheduleDailyReminder(); };
  $('#setRate').oninput = debounce((e) => { STATE.settings.rate = +e.target.value; $('#rateVal').textContent = e.target.value + 'x'; saveAll(); }, 100);
  $('#setRepeat').onchange = (e) => { STATE.settings.repeat = +e.target.value; saveAll(); };
  $('#setPause').onchange = (e) => { STATE.settings.pauseSec = +e.target.value; saveAll(); };
  $('#setAutoStop').onchange = (e) => { STATE.settings.autoStop = e.target.checked; saveAll(); };
  $('#setReadExample').onchange = (e) => { STATE.settings.readExample = e.target.checked; saveAll(); };
  $('#setIntervals').onchange = (e) => {
    const arr = e.target.value.split(',').map(s => +s.trim()).filter(n => n > 0);
    if (arr.length > 0) { STATE.settings.intervals = arr; saveAll(); }
  };
  $('#setMasterCount').onchange = (e) => { STATE.settings.masterCount = +e.target.value; saveAll(); };

  $('#exportBtn').onclick = () => {
    const blob = new Blob([JSON.stringify({ words: STATE.words, settings: STATE.settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vocab-backup-${todayStr()}.json`;
    a.click();
    toast('已导出 ✓');
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('文件过大，请小于5MB'); return; }
    try {
      const txt = await f.text();
      const data = JSON.parse(txt);
      // 白名单校验
      const validWordKeys = ['id','word','phonetic','meaning','example','note','createdAt','reviewCount','correctStreak','nextReviewAt','mastered','masteredAt'];
      const validSettingKeys = ['reminderOn','reminderTime','rate','repeat','pauseSec','autoStop','readExample','intervals','masterCount'];
      if (Array.isArray(data.words)) {
        const cleanWords = data.words.map(w => {
          const clean = {};
          validWordKeys.forEach(k => { if (k in w) clean[k] = w[k]; });
          return clean;
        }).filter(w => w.word && w.meaning);
        if (!confirm(`导入 ${cleanWords.length} 个有效单词?这会与现有词库合并(同名覆盖)`)) return;
        const map = new Map(STATE.words.map(w => [w.word.toLowerCase(), w]));
        cleanWords.forEach(w => map.set(w.word.toLowerCase(), { ...map.get(w.word.toLowerCase()), ...w }));
        STATE.words = Array.from(map.values());
        if (data.settings) {
          const cleanSettings = {};
          validSettingKeys.forEach(k => { if (k in data.settings) cleanSettings[k] = data.settings[k]; });
          STATE.settings = { ...STATE.settings, ...cleanSettings };
        }
        saveAll(); toast('导入成功 ✓'); refreshHome(); refreshLib(); bindSettings();
      } else toast('文件格式错误');
    } catch (err) { toast('导入失败:' + err.message); }
  };
  $('#clearBtn').onclick = () => {
    if (!confirm('确定清空所有单词和设置吗?此操作不可撤销!')) return;
    if (!confirm('再次确认:真的要清空吗?')) return;
    localStorage.removeItem(STORAGE_KEY);
    STATE.words = [];
    STATE.settings = {
      reminderOn: false, reminderTime: '20:00', rate: 0.8, repeat: 2,
      pauseSec: 3, autoStop: true, readExample: true,
      intervals: [1,2,4,7,15,30], masterCount: 5
    };
    refreshHome(); refreshLib(); bindSettings();
    toast('已清空');
  };
}

// ========== 事件绑定 ==========
function bindEvents() {
  $('#settingsBtn').onclick = () => { showPage('settings'); };
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('[data-back]')) { showPage('home'); refreshHome(); refreshLib(); }
    // 试听按钮事件委托
    const ttsBtn = e.target.closest('[data-tts-word]');
    if (ttsBtn) { speak(ttsBtn.dataset.ttsWord, { rate: STATE.settings.rate }); }
  });

  $('#enterDriveBtn').onclick = () => {
    showPage('drive');
    STATE.drive.queue = []; STATE.drive.idx = 0;
    renderDriveWord({ word: '准备就绪', phonetic: '', meaning: '点击 ▶ 开始播放' });
    $('#driveProgress').textContent = '— / —';
  };
  $('#enterReviewBtn').onclick = startReview;
  $('#enterAddBtn').onclick = () => { showPage('add'); setTimeout(() => $('#wordInput').focus(), 200); };
  $('#enterLibBtn').onclick = () => { showPage('lib'); libPage = 1; refreshLib(); };

  $('#lookupBtn').onclick = handleLookup;
  $('#wordInput').addEventListener('keypress', (e) => { if (e.key === 'Enter') handleLookup(); });
  $('#saveWordBtn').onclick = handleSaveWord;

  $$('.tab').forEach(t => {
    t.onclick = () => {
      $$('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      libTab = t.dataset.tab; libPage = 1;
      refreshLib();
    };
  });
  $('#searchInput').addEventListener('input', debounce(() => { libPage = 1; refreshLib(); }, 200));
  $('#libList').addEventListener('click', handleLibAction);

  $('#flashCard').onclick = flipCard;
  $('#cardSpeak').onclick = (e) => {
    e.stopPropagation();
    const w = STATE.reviewQueue[STATE.reviewIdx];
    if (w) speak(w.word, { rate: STATE.settings.rate });
  };
  $('#forgetBtn').onclick = () => reviewAnswer('forget');
  $('#hardBtn').onclick = () => reviewAnswer('hard');
  $('#goodBtn').onclick = () => reviewAnswer('good');
  $('#masterBtn').onclick = () => reviewAnswer('master');

  $('#drivePlayBtn').onclick = () => { STATE.drive.playing ? drivePause() : drivePlay(); };
  $('#driveNextBtn').onclick = driveNext;
  $('#drivePrevBtn').onclick = drivePrev;
  $('#driveRepeatBtn').onclick = driveRepeat;
  $('#driveVoiceBtn').onclick = toggleVoiceControl;

  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => { if (!STATE.drive.playing) drivePlay(); });
    navigator.mediaSession.setActionHandler('pause', () => drivePause());
    navigator.mediaSession.setActionHandler('nexttrack', () => driveNext());
    navigator.mediaSession.setActionHandler('previoustrack', () => drivePrev());
  }
}

// ========== PWA 安装 ==========
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('#installBtn').hidden = false;
  $('#installTip').hidden = false;
});
function bindInstall() {
  const trigger = async () => {
    if (!deferredPrompt) { toast('已安装或浏览器暂不支持,可在浏览器菜单选择"添加到主屏幕"'); return; }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') toast('安装成功 🎉');
    deferredPrompt = null;
    $('#installBtn').hidden = true;
    $('#installTip').hidden = true;
  };
  $('#installBtn').onclick = trigger;
  $('#installTipBtn').onclick = trigger;
  $('#installTipClose').onclick = () => {
    const tip = $('#installTip');
    if (tip) tip.style.display = 'none';
  };
  // 如果已经是独立应用模式(已安装),自动隐藏安装提示
  if (window.matchMedia('(display-mode: standalone)').matches) {
    const tip = $('#installTip');
    if (tip) tip.style.display = 'none';
    const btn = $('#installBtn');
    if (btn) btn.style.display = 'none';
  }
}

// ========== 启动 ==========
async function init() {
  loadAll();
  initTTS();
  bindEvents();
  bindSettings();
  bindInstall();
  refreshHome();

  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('SW 注册失败', e); }
  }

  if (STATE.settings.reminderOn) setupReminder();
}

document.addEventListener('DOMContentLoaded', init);
