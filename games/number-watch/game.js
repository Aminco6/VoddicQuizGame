
(function(){
"use strict";

// ==================== VODDIC AUTH ====================
window.__VODDIC__ = {
  token: null,
  apiBase: null,
  userEmail: null,
  userName: null,
  stageId: null,
  stageSlug: null,
  playResp: null,
  ready: false
};

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'voddic_auth') {
    window.__VODDIC__.token = e.data.accessToken;
    window.__VODDIC__.apiBase = e.data.apiBase;
    window.__VODDIC__.userEmail = e.data.userEmail;
    window.__VODDIC__.userName = e.data.userName;
    window.__VODDIC__.stageId = e.data.stageId;
    window.__VODDIC__.stageSlug = e.data.stageSlug;
    window.__VODDIC__.playResp = e.data.playResp;
    window.__VODDIC__.ready = true;
    console.log('✅ Voddic auth received');
    window.dispatchEvent(new Event('voddic_ready'));
  }
});

async function voddicFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (window.__VODDIC__.token) headers['Authorization'] = `Bearer ${window.__VODDIC__.token}`;
  const url = `${window.__VODDIC__.apiBase}${path}`;
  const res = await fetch(url, { ...opts, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ==================== STATE ====================
var DURATION_MS = 5*60*1000;
var LANES = 6;
var track = document.getElementById('track');
var target = null;
var sessionToken = null;
var running = false;
var startTime = 0;
var lastFrame = 0;
var activeNumbers = [];
var laneY = [];
var laneSpacing = 0;
var currentWindowEndMs = 0;

var displayTally = { hits:0, misses:0, wrong:0 };
var eventQueue = [];
var flushTimer = null;
var pollTimer = null;
var heartbeatTimer = null;

// ==================== HELPERS ====================
function newEventId() {
  return 'ev_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
}

function showConnStatus(msg) {
  let el = document.getElementById('connStatus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'connStatus';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  setTimeout(() => el.classList.remove('on'), 2500);
}

// ==================== INTRO ====================
function initIntro() {
  document.getElementById('targetPreview').textContent = '?';
  document.getElementById('introNote').textContent =
    'Your target will be assigned by the server when you start.';
  document.getElementById('startBtn').disabled = false;
}

document.getElementById('startBtn').addEventListener('click', startServerSession);
document.getElementById('backBtn').addEventListener('click', () => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'voddic_game_complete', reason: 'user_back' }, '*');
  }
});

// ==================== START SERVER SESSION ====================
async function startServerSession() {
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    if (!window.__VODDIC__.ready) {
      // Wait for auth message up to 5 seconds
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Auth not received')), 5000);
        window.addEventListener('voddic_ready', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }

    const stageId = window.__VODDIC__.stageId;
    if (!stageId) throw new Error('No stage ID provided');

    const session = await voddicFetch('/game/start/', {
      method: 'POST',
      body: JSON.stringify({ stage_id: stageId })
    });

    sessionToken = session.session_token;
    target = session.target_value;
    DURATION_MS = session.duration_seconds * 1000;

    console.log('✅ Session started:', session.session_token);
    console.log('   Target:', target);
    console.log('   Duration:', session.duration_seconds, 's');

    document.getElementById('targetPreview').textContent = target;
    beginGame(session);
  } catch (e) {
    console.error('Start failed:', e);
    alert('Could not start game: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Start (5:00)';
  }
}

// ==================== BEGIN GAME ====================
function beginGame(session) {
  document.getElementById('intro').style.display = 'none';
  document.getElementById('hud').classList.add('on');
  document.getElementById('timerBar').classList.add('on');
  document.getElementById('targetBadge').classList.add('on');
  document.getElementById('track').classList.add('on');
  document.getElementById('liveTally').classList.add('on');

  document.getElementById('hudTarget').textContent = target;
  document.getElementById('targetBadgeNum').textContent = target;

  displayTally = { hits:0, misses:0, wrong:0 };
  activeNumbers = [];
  eventQueue = [];

  setupLanes();

  // Load first window
  if (session.windows && session.windows.length > 0) {
    for (const w of session.windows) {
      scheduleWindow(w);
      currentWindowEndMs = Math.max(currentWindowEndMs, w.ends_at_ms);
    }
  }

  running = true;
  startTime = performance.now();
  lastFrame = startTime;
  requestAnimationFrame(loop);

  // Start periodic flushers/pollers
  flushTimer = setInterval(flushEvents, 1200);
  pollTimer = setInterval(pollWindows, 8000);
  heartbeatTimer = setInterval(sendHeartbeat, 5000);
}

// ==================== LANES ====================
function setupLanes() {
  var h = track.clientHeight || 300;
  var w = track.clientWidth || 600;
  laneY = [];
  track.innerHTML = '';
  for (var i = 0; i < LANES; i++) {
    var y = (h / (LANES + 1)) * (i + 1);
    laneY.push(y);
    var guide = document.createElement('div');
    guide.className = 'guide';
    guide.style.top = y + 'px';
    track.appendChild(guide);
  }
  laneSpacing = (w * LANES) / 12;
}

// ==================== WINDOW SCHEDULING ====================
function scheduleWindow(windowData) {
  if (!windowData || !windowData.objects) return;
  for (const obj of windowData.objects) {
    scheduleObject(obj);
  }
  if (windowData.target_changes) {
    for (const tc of windowData.target_changes) {
      scheduleTargetChange(tc);
    }
  }
}

function scheduleObject(obj) {
  const delay = obj.spawn_at_ms - (performance.now() - startTime);
  if (delay <= 0) {
    spawnObject(obj);
  } else {
    setTimeout(() => spawnObject(obj), delay);
  }
}

function scheduleTargetChange(tc) {
  const delay = tc.at_ms - (performance.now() - startTime);
  if (delay <= 0) return;
  setTimeout(() => {
    target = tc.new_target;
    document.getElementById('hudTarget').textContent = tc.new_target;
    document.getElementById('targetBadgeNum').textContent = tc.new_target;
    showTargetChangeBanner(tc.new_target);
  }, delay);
}

function showTargetChangeBanner(newTarget) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(14,19,32,0.9);border-radius:10px;';
  overlay.innerHTML = `
    <div style="font-size:14px;color:#3FC7B0;letter-spacing:2px;margin-bottom:10px;">TARGET CHANGED</div>
    <div style="font-size:72px;font-weight:900;color:#E8B94C;">${newTarget}</div>
    <div style="font-size:13px;color:#8B93A7;margin-top:10px;">Tap every ${newTarget} you see</div>
  `;
  track.parentNode.style.position = 'relative';
  track.parentNode.appendChild(overlay);
  setTimeout(() => overlay.remove(), 1800);
}

// ==================== SPAWN OBJECT ====================
function spawnObject(obj) {
  var w = track.clientWidth || 600;
  var el = document.createElement('div');
  el.className = 'num-piece';
  el.textContent = obj.value;
  el.style.left = w + 'px';
  el.style.top = laneY[obj.lane] + 'px';
  var bd = obj.blink_duration || 1.0;
  el.style.animationDuration = bd + 's';
  el.style.animationDelay = '-' + (Math.random() * 1.4).toFixed(2) + 's';

  var piece = {
    el: el,
    x: w,
    objId: obj.object_id,
    isTarget: obj.is_target,
    lane: obj.lane,
    spawnPerfMs: performance.now() - startTime,
    done: false
  };

  el.addEventListener('pointerdown', () => {
    if (piece.done || !running) return;
    piece.done = true;
    const nowMs = Math.round(performance.now() - startTime);

    // Queue event — server validates
    eventQueue.push({
      event_id: newEventId(),
      object_id: piece.objId,
      action: 'tap',
      client_time_ms: nowMs
    });

    // Optimistic visual feedback
    if (piece.isTarget) {
      el.classList.add('correct-flash');
      displayTally.hits++;
    } else {
      el.classList.add('wrong-flash');
      displayTally.wrong++;
    }
    updateTally();
    setTimeout(() => { el.style.opacity = '0'; }, 150);
  });

  track.appendChild(el);
  activeNumbers.push(piece);
}

// ==================== LOOP ====================
function loop(now) {
  if (!running) return;
  var dt = (now - lastFrame) / 1000;
  lastFrame = now;
  var elapsedMs = now - startTime;

  if (elapsedMs >= DURATION_MS) {
    endGame();
    return;
  }

  var speed = 55 + (320 - 55) * Math.min(elapsedMs / DURATION_MS, 1);

  var remaining = Math.max(0, DURATION_MS - elapsedMs);
  var m = Math.floor(remaining / 60000);
  var s = Math.floor((remaining % 60000) / 1000);
  document.getElementById('hudTime').textContent = `${m}:${(s<10?'0':'')}${s} remaining`;
  document.getElementById('timerFill').style.width = (100 - (elapsedMs / DURATION_MS) * 100) + '%';

  for (var i = activeNumbers.length - 1; i >= 0; i--) {
    var p = activeNumbers[i];
    p.x -= speed * dt;
    p.el.style.left = p.x + 'px';
    if (p.x < -50) {
      if (!p.done && p.isTarget) {
        displayTally.misses++;
        updateTally();
      }
      p.el.remove();
      activeNumbers.splice(i, 1);
    }
  }

  requestAnimationFrame(loop);
}

function updateTally() {
  document.getElementById('tallyHits').textContent = displayTally.hits;
  document.getElementById('tallyMisses').textContent = displayTally.misses;
  document.getElementById('tallyWrong').textContent = displayTally.wrong;
}

// ==================== EVENT FLUSH ====================
async function flushEvents() {
  if (!sessionToken || eventQueue.length === 0) return;
  const batch = eventQueue.splice(0, eventQueue.length);
  try {
    await voddicFetch('/game/events/', {
      method: 'POST',
      body: JSON.stringify({ session_token: sessionToken, events: batch })
    });
  } catch (e) {
    console.warn('Event flush failed, re-queuing:', e);
    eventQueue.unshift(...batch);
    showConnStatus('● reconnecting…');
  }
}

// ==================== POLL WINDOWS ====================
async function pollWindows() {
  if (!sessionToken || !running) return;
  try {
    const res = await voddicFetch(`/game/session/${sessionToken}/windows/?from_ms=${currentWindowEndMs}`);
    if (res.windows && res.windows.length > 0) {
      for (const w of res.windows) {
        scheduleWindow(w);
        currentWindowEndMs = Math.max(currentWindowEndMs, w.ends_at_ms);
      }
    }
  } catch (e) {
    console.warn('Window poll failed:', e);
    showConnStatus('● connection slow');
  }
}

// ==================== HEARTBEAT ====================
async function sendHeartbeat() {
  if (!sessionToken || !running) return;
  try {
    await voddicFetch('/game/heartbeat/', {
      method: 'POST',
      body: JSON.stringify({ session_token: sessionToken })
    });
  } catch (e) {
    showConnStatus('● reconnecting…');
  }
}

// ==================== END GAME ====================
async function endGame() {
  running = false;
  clearInterval(flushTimer);
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);

  // Flush remaining events
  await flushEvents();

  // Mark leftover targets as misses (local display only — server recomputes)
  activeNumbers.forEach(p => {
    if (!p.done && p.isTarget) {
      displayTally.misses++;
    }
    p.el.remove();
  });
  activeNumbers = [];

  document.getElementById('hud').classList.remove('on');
  document.getElementById('timerBar').classList.remove('on');
  document.getElementById('targetBadge').classList.remove('on');
  document.getElementById('track').classList.remove('on');
  document.getElementById('liveTally').classList.remove('on');

  // Ask server to finalize
  try {
    const finish = await voddicFetch('/game/finish/', {
      method: 'POST',
      body: JSON.stringify({ session_token: sessionToken })
    });
    console.log('Finish response:', finish);

    if (finish.status === 'PENDING') {
      showPending();
      pollForResult();
    } else {
      showResult(finish);
    }
  } catch (e) {
    console.error('Finish failed:', e);
    showResult({
      final_score: 0, correct: 0, wrong: 0, missed: 0,
      accuracy: 0, avg_reaction_ms: 0, prize_eligible: false,
      integrity_status: 'UNKNOWN'
    });
  }
}

function showPending() {
  document.getElementById('summary').innerHTML = `
    <h1>Verifying…</h1>
    <p class="lede">Server is finalizing your result. Please wait.</p>
  `;
  document.getElementById('summary').style.display = 'block';
}

async function pollForResult() {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const res = await voddicFetch(`/game/session/${sessionToken}/result/`);
      if (res.status === 'FINALIZED') {
        clearInterval(poll);
        showResult(res);
      }
    } catch (e) {}
    if (attempts > 30) {
      clearInterval(poll);
      showResult({ final_score: 0, correct: 0, wrong: 0, missed: 0, accuracy: 0, avg_reaction_ms: 0, prize_eligible: false, integrity_status: 'TIMEOUT' });
    }
  }, 2000);
}

function showResult(r) {
  const summary = document.getElementById('summary');
  summary.innerHTML = `
    <h1>Session complete</h1>
    <p class="lede">Server-verified result.</p>
    <div class="row"><span>Final Score</span><span class="v">${r.final_score ?? 0}</span></div>
    <div class="row"><span>Correct taps</span><span class="v">${r.correct ?? 0}</span></div>
    <div class="row"><span>Missed targets</span><span class="v">${r.missed ?? 0}</span></div>
    <div class="row"><span>Wrong taps</span><span class="v">${r.wrong ?? 0}</span></div>
    <div class="row"><span>Accuracy</span><span class="v">${Math.round((r.accuracy ?? 0) * 100)}%</span></div>
    <div class="row"><span>Avg reaction</span><span class="v">${r.avg_reaction_ms ?? 0} ms</span></div>
    <div class="row"><span>Prize eligible</span><span class="v">${r.prize_eligible ? '✅ Yes' : '— Not eligible'}</span></div>
    <p class="footnote">Integrity: ${r.integrity_status || 'VALID'}</p>
    <button class="btn secondary" onclick="window.parent.postMessage({type:'voddic_game_complete',result:${JSON.stringify(r)}},'*')" style="margin-top:8px;">Back to Arena</button>
  `;
  summary.style.display = 'block';

  // Notify parent
  if (window.parent !== window) {
    window.parent.postMessage({
      type: 'voddic_game_complete',
      result: r
    }, '*');
  }
}

// ==================== INIT ====================
initIntro();
console.log('Number Watch loaded — waiting for auth…');
})();
