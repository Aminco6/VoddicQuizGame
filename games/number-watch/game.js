(function(){
"use strict";

// ==================== VODDIC AUTH ====================
window.__VODDIC__ = {
  token: null, apiBase: null, userEmail: null, userName: null,
  stageId: null, stageSlug: null, playResp: null, ready: false
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
var DURATION_MS = 5 * 60 * 1000;
var LANES = 6;
var track = document.getElementById('track');
var target = null;
var sessionToken = null;
var running = false;
var startTime = 0;
var lastFrame = 0;
var activeNumbers = [];
var laneY = [];
var lastWindowIndex = -1;

var displayTally = { hits: 0, misses: 0, wrong: 0 };
var eventQueue = [];
var flushTimer = null;
var pollTimer = null;
var heartbeatTimer = null;
var targetBannerEl = null;

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
  setTimeout(() => el.classList.remove('on'), 2000);
}

// ==================== INTRO ====================
function initIntro() {
  document.getElementById('targetPreview').textContent = '?';
  document.getElementById('introNote').textContent = 'Target assigned by server when you start.';
  document.getElementById('startBtn').disabled = false;
}

document.getElementById('startBtn').addEventListener('click', startServerSession);
document.getElementById('backBtn').addEventListener('click', () => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'voddic_game_complete', reason: 'user_back' }, '*');
  }
});

// ==================== START ====================
async function startServerSession() {
  const btn = document.getElementById('startBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    if (!window.__VODDIC__.ready) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Auth timeout')), 5000);
        window.addEventListener('voddic_ready', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }

    const stageId = window.__VODDIC__.stageId;
    if (!stageId) throw new Error('No stage ID');

    const session = await voddicFetch('/game/start/', {
      method: 'POST',
      body: JSON.stringify({ stage_id: stageId })
    });

    sessionToken = session.session_token;
    target = session.target_value;
    DURATION_MS = session.duration_seconds * 1000;

    console.log('✅ Session:', sessionToken);
    console.log('   Target:', target);

    document.getElementById('targetPreview').textContent = target;
    beginGame(session);
  } catch (e) {
    console.error('Start failed:', e);
    alert('Could not start: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Start (5:00)';
  }
}

// ==================== BEGIN ====================
function beginGame(session) {
  document.getElementById('intro').style.display = 'none';
  document.getElementById('hud').classList.add('on');
  document.getElementById('timerBar').classList.add('on');
  document.getElementById('targetBadge').classList.add('on');
  document.getElementById('track').classList.add('on');
  document.getElementById('liveTally').classList.add('on');

  document.getElementById('hudTarget').textContent = target;
  document.getElementById('targetBadgeNum').textContent = target;

  displayTally = { hits: 0, misses: 0, wrong: 0 };
  activeNumbers = [];
  eventQueue = [];
  lastWindowIndex = -1;

  setupLanes();

  // Schedule the initial windows
  if (session.windows && session.windows.length > 0) {
    for (const w of session.windows) {
      scheduleWindow(w);
      lastWindowIndex = Math.max(lastWindowIndex, w.window_index);
    }
    console.log(`📦 Scheduled initial windows 0..${lastWindowIndex}`);
  }

  running = true;
  startTime = performance.now();
  lastFrame = startTime;
  requestAnimationFrame(loop);

  flushTimer = setInterval(flushEvents, 1200);
  pollTimer = setInterval(pollWindows, 5000);
  heartbeatTimer = setInterval(sendHeartbeat, 5000);
}

// ==================== LANES ====================
function setupLanes() {
  var h = track.clientHeight || 300;
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
}

// ==================== WINDOW SCHEDULING ====================
function scheduleWindow(windowData) {
  if (!windowData) return;
  console.log(`📦 Scheduling window ${windowData.window_index}: ${windowData.objects.length} objects, ${windowData.target_changes.length} target changes`);
  
  if (windowData.objects) {
    for (const obj of windowData.objects) {
      scheduleObject(obj);
    }
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
    // Object's spawn time already passed — spawn immediately
    spawnObject(obj);
  } else {
    setTimeout(() => spawnObject(obj), delay);
  }
}

function scheduleTargetChange(tc) {
  const delay = tc.at_ms - (performance.now() - startTime);
  console.log(`🎯 Target change scheduled in ${delay}ms → ${tc.new_target}`);
  if (delay <= 0) {
    applyTargetChange(tc.new_target);
  } else {
    setTimeout(() => applyTargetChange(tc.new_target), delay);
  }
}

function applyTargetChange(newTarget) {
  target = newTarget;
  document.getElementById('hudTarget').textContent = newTarget;
  document.getElementById('targetBadgeNum').textContent = newTarget;
  showTargetChangeBanner(newTarget);
}

function showTargetChangeBanner(newTarget) {
  // Remove any existing banner
  if (targetBannerEl) targetBannerEl.remove();
  
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:absolute; inset:0; z-index:100;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    background:rgba(14,19,32,0.92); border-radius:10px;
    animation: fadeIn 0.15s ease;
  `;
  overlay.innerHTML = `
    <div style="font-size:14px;color:#3FC7B0;letter-spacing:3px;margin-bottom:14px;font-weight:700;">TARGET CHANGED</div>
    <div style="font-size:88px;font-weight:900;color:#E8B94C;line-height:1;text-shadow:0 0 30px rgba(232,185,76,0.6);">${newTarget}</div>
    <div style="font-size:14px;color:#EDEFF4;margin-top:16px;">Tap every ${newTarget} you see</div>
  `;
  track.parentNode.style.position = 'relative';
  track.parentNode.appendChild(overlay);
  targetBannerEl = overlay;
  
  // Auto-dismiss after 2 seconds
  setTimeout(() => {
    overlay.style.transition = 'opacity 0.3s ease';
    overlay.style.opacity = '0';
    setTimeout(() => {
      overlay.remove();
      if (targetBannerEl === overlay) targetBannerEl = null;
    }, 300);
  }, 2000);
}

// ==================== SPAWN ====================
function spawnObject(obj) {
  if (!running) return;
  
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
    velocity: obj.velocity,
    spawnPerfMs: performance.now() - startTime,
    done: false
  };

  el.addEventListener('pointerdown', () => {
    if (piece.done || !running) return;
    piece.done = true;
    const nowMs = Math.round(performance.now() - startTime);

    eventQueue.push({
      event_id: newEventId(),
      object_id: piece.objId,
      action: 'tap',
      client_time_ms: nowMs
    });

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

  // Speed ramps 55 → 320 px/s across the full duration
  var speed = 55 + (320 - 55) * Math.min(elapsedMs / DURATION_MS, 1);

  var remaining = Math.max(0, DURATION_MS - elapsedMs);
  var m = Math.floor(remaining / 60000);
  var s = Math.floor((remaining % 60000) / 1000);
  document.getElementById('hudTime').textContent = `${m}:${(s < 10 ? '0' : '')}${s} remaining`;
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

// ==================== EVENTS ====================
async function flushEvents() {
  if (!sessionToken || eventQueue.length === 0) return;
  const batch = eventQueue.splice(0, eventQueue.length);
  try {
    await voddicFetch('/game/events/', {
      method: 'POST',
      body: JSON.stringify({ session_token: sessionToken, events: batch })
    });
  } catch (e) {
    console.warn('Flush failed, re-queue:', e);
    eventQueue.unshift(...batch);
    showConnStatus('● reconnecting…');
  }
}

// ==================== POLL WINDOWS ====================
async function pollWindows() {
  if (!sessionToken || !running) return;
  try {
    const elapsedMs = Math.round(performance.now() - startTime);
    const res = await voddicFetch(`/game/session/${sessionToken}/windows/?from_ms=${elapsedMs}`);
    if (res.windows && res.windows.length > 0) {
      let newCount = 0;
      for (const w of res.windows) {
        if (w.window_index > lastWindowIndex) {
          scheduleWindow(w);
          lastWindowIndex = w.window_index;
          newCount++;
        }
      }
      if (newCount > 0) console.log(`📦 Loaded ${newCount} new windows`);
    }
  } catch (e) {
    console.warn('Poll failed:', e);
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

// ==================== END ====================
async function endGame() {
  running = false;
  clearInterval(flushTimer);
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);

  await flushEvents();

  activeNumbers.forEach(p => {
    if (!p.done && p.isTarget) displayTally.misses++;
    p.el.remove();
  });
  activeNumbers = [];

  document.getElementById('hud').classList.remove('on');
  document.getElementById('timerBar').classList.remove('on');
  document.getElementById('targetBadge').classList.remove('on');
  document.getElementById('track').classList.remove('on');
  document.getElementById('liveTally').classList.remove('on');

  // Show loading state while finalizing
  document.getElementById('summary').innerHTML = `
    <h1>Verifying…</h1>
    <p class="lede">Server is calculating your final score.</p>
  `;
  document.getElementById('summary').style.display = 'block';

  try {
    const finish = await voddicFetch('/game/finish/', {
      method: 'POST',
      body: JSON.stringify({ session_token: sessionToken })
    });
    console.log('Finish:', finish);

    if (finish.status === 'PENDING') {
      pollForResult();
    } else {
      showResult(finish);
    }
  } catch (e) {
    console.error('Finish failed:', e);
    // Even if finish fails, try polling the result
    pollForResult();
  }
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
        return;
      }
    } catch (e) { /* keep polling */ }
    
    if (attempts > 30) {
      clearInterval(poll);
      showResult({
        final_score: 0, correct: 0, wrong: 0, missed: 0,
        accuracy: 0, avg_reaction_ms: 0, prize_eligible: false,
        integrity_status: 'TIMEOUT'
      });
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
    <button class="btn secondary" onclick="window.parent.postMessage({type:'voddic_game_complete'},'*')" style="margin-top:12px;">Back to Arena</button>
  `;
  summary.style.display = 'block';

  if (window.parent !== window) {
    window.parent.postMessage({ type: 'voddic_game_complete', result: r }, '*');
  }
}

initIntro();
console.log('Number Watch loaded — waiting for auth…');
})();
