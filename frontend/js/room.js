import { TimeGrid } from './grid.js';
import { WSClient } from './ws.js';

const params = new URLSearchParams(location.search);
const roomId = params.get('id') || '';
if (!roomId) { location.href = '/'; }

let userId = sessionStorage.getItem(`userId:${roomId}`);
let userName = sessionStorage.getItem(`name:${roomId}`);

// ── Date helpers ──
const MONTHS_EN = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
                   'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const DOW_EN  = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const DOW_KO  = ['일','월','화','수','목','금','토'];

function toISO(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

// Calendar range: 1st of (today - 1 month) to last day of (today + 6 months)
const CAL_START = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1);
const CAL_END   = new Date(TODAY.getFullYear(), TODAY.getMonth() + 7, 0);

// ALL_DATES for day chips in detail view
const ALL_DATES = [];
for (let d = new Date(CAL_START); d <= CAL_END; d = addDays(d, 1)) {
  ALL_DATES.push(toISO(d));
}

// ── Modal ──
function showNameModal(cb) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>TimeAligner</h2>
      <p>방 코드: <strong>${roomId}</strong></p>
      <form id="name-form">
        <label>이름<input type="text" id="modal-name" placeholder="홍길동" required maxlength="20" autofocus></label>
        <button type="submit" class="btn-primary">참여하기</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    userName = document.getElementById('modal-name').value.trim();
    userId = crypto.randomUUID();
    sessionStorage.setItem(`name:${roomId}`, userName);
    sessionStorage.setItem(`userId:${roomId}`, userId);
    overlay.remove();
    cb();
  });
}

// ── DOM ──
const calView      = document.getElementById('cal-view');
const detailView   = document.getElementById('detail-view');
const calGrid      = document.getElementById('cal-grid');
const backBtn      = document.getElementById('back-btn');
const dayChipsEl   = document.getElementById('day-chips');
const currentDayLabel  = document.getElementById('current-day-label');
const recsContainer    = document.getElementById('recommendations');
const roomUrlInput     = document.getElementById('room-url-input');
const copyBtn          = document.getElementById('copy-btn');
const participantCount = document.getElementById('participant-count');
const statusDot        = document.getElementById('status-dot');

roomUrlInput.value = roomId;
copyBtn.addEventListener('click', async () => {
  let ok = false;
  try { await navigator.clipboard.writeText(roomId); ok = true; } catch (_) {}
  if (!ok) {
    roomUrlInput.select();
    try { ok = document.execCommand('copy'); } catch (_) {}
    window.getSelection()?.removeAllRanges();
  }
  copyBtn.textContent = ok ? '복사됨!' : '실패';
  copyBtn.classList.add('copied');
  setTimeout(() => { copyBtn.textContent = '복사'; copyBtn.classList.remove('copied'); }, 2000);
});

document.getElementById('logo-btn').addEventListener('click', () => location.reload());

// ── Leave button (HTTP DELETE for reliability) ──
document.getElementById('leave-btn').addEventListener('click', async () => {
  if (!confirm('참석자 목록에서 완전히 제거됩니다.\n입력한 가용 시간도 삭제됩니다. 나가시겠습니까?')) return;
  try {
    await fetch(`/api/rooms/${roomId}/participants/${userId}`, { method: 'DELETE' });
  } catch (_) {}
  if (ws) { ws._closed = true; ws._ws?.close(); }
  sessionStorage.removeItem(`name:${roomId}`);
  sessionStorage.removeItem(`userId:${roomId}`);
  location.href = '/';
});

// ── DOM refs for calendar nav ──
const calPrevBtn   = document.getElementById('cal-prev');
const calNextBtn   = document.getElementById('cal-next');
const calYearLabel = document.getElementById('cal-year-label');
const calMonthLabel = document.getElementById('cal-month-label');

// ── State ──
let grid = null;
let ws   = null;
let serverState = { participants: {}, names: {}, recommended_slots: [] };
let currentDate = toISO(TODAY);
let calMonthOffset = 0; // -1 to +6 relative to current month

function getDayView(participants, dateStr) {
  const result = {};
  for (const [uid, daysData] of Object.entries(participants)) {
    result[uid] = daysData[dateStr] || new Array(48).fill(0);
  }
  return result;
}

function hasDataForDate(participants, dateStr) {
  return Object.values(participants).some(d => d[dateStr]?.some(v => v === 1));
}

function overlapCount(participants, dateStr) {
  return Object.values(participants).filter(d => d[dateStr]?.some(v => v === 1)).length;
}

// ── Calendar nav helpers ──
function updateCalNav() {
  const firstOfMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + calMonthOffset, 1);
  calYearLabel.textContent  = firstOfMonth.getFullYear();
  calMonthLabel.textContent = MONTHS_EN[firstOfMonth.getMonth()];
  calPrevBtn.classList.toggle('disabled', calMonthOffset <= -1);
  calNextBtn.classList.toggle('disabled', calMonthOffset >= 6);
}

calPrevBtn.addEventListener('click', () => {
  if (calMonthOffset <= -1) return;
  calMonthOffset--;
  updateCalNav();
  buildCalGrid(serverState.participants, serverState.recommended_slots);
});
calNextBtn.addEventListener('click', () => {
  if (calMonthOffset >= 6) return;
  calMonthOffset++;
  updateCalNav();
  buildCalGrid(serverState.participants, serverState.recommended_slots);
});

// ── Calendar view (single month) ──
function buildCalGrid(participants, recs) {
  calGrid.innerHTML = '';
  const n = Object.keys(participants).length;

  const firstOfMonth = new Date(TODAY.getFullYear(), TODAY.getMonth() + calMonthOffset, 1);
  const year  = firstOfMonth.getFullYear();
  const month = firstOfMonth.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();

  // Blank offset from Sunday
  const startDow = new Date(year, month, 1).getDay();
  for (let i = 0; i < startDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell cal-blank';
    calGrid.appendChild(blank);
  }

  for (let day = 1; day <= lastDay; day++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow  = new Date(year, month, day).getDay();
    const cnt  = overlapCount(participants, iso);
    const hasMe   = participants[userId]?.[iso]?.some(v => v === 1);
    const isToday = iso === toISO(TODAY);
    const isCurrent = iso === currentDate;
    const topRec = recs.find(r => r.date === iso);

    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.dataset.date = iso;
    if (dow === 6) cell.classList.add('sat');
    if (dow === 0) cell.classList.add('sun');
    if (isToday)   cell.classList.add('today');
    if (isCurrent) cell.classList.add('active');
    if (hasMe)     cell.classList.add('has-me');
    if (cnt > 0) {
      cell.classList.add('has-data');
      cell.style.setProperty('--overlap-ratio', n > 0 ? cnt / n : 0);
    }

    let recHtml = '';
    if (topRec) {
      const mins = topRec.duration_slots * 30;
      const durStr = mins >= 60 ? `${mins / 60}h` : `${mins}m`;
      recHtml = `<span class="cal-cell-time">${topRec.start_time}~${topRec.end_time}</span>
                 <span class="cal-cell-att">${topRec.attendance_count}/${n}명 · ${durStr}</span>`;
    } else if (cnt > 0) {
      recHtml = `<span class="cal-overlap-badge">${cnt}명 참여</span>`;
    }

    cell.innerHTML = `<span class="cal-date">${day}</span>${recHtml}`;
    cell.addEventListener('click', () => showDetailView(iso));
    calGrid.appendChild(cell);
  }
}

function showCalView() {
  calView.hidden  = false;
  detailView.hidden = true;
  // Sync displayed month to currentDate's month
  const d = new Date(currentDate + 'T00:00:00');
  const raw = (d.getFullYear() - TODAY.getFullYear()) * 12 + (d.getMonth() - TODAY.getMonth());
  calMonthOffset = Math.max(-1, Math.min(6, raw));
  updateCalNav();
  buildCalGrid(serverState.participants, serverState.recommended_slots);
}

// ── Day detail view ──
function showDetailView(dateStr) {
  currentDate = dateStr;
  calView.hidden  = true;
  detailView.hidden = false;

  const d = new Date(dateStr + 'T00:00:00');
  currentDayLabel.textContent = `${d.getMonth() + 1}/${d.getDate()}(${DOW_KO[d.getDay()]})`;

  buildDayChips();
  scrollActiveChip();

  if (!grid) {
    grid = new TimeGrid('time-grid', userId, userName, (slots) => ws?.sendSlots(currentDate, slots));
  }

  grid.updateAll(getDayView(serverState.participants, currentDate), serverState.names);
  highlightRecForDate(currentDate);
}

function buildDayChips() {
  dayChipsEl.innerHTML = '';
  for (const iso of ALL_DATES) {
    const d   = new Date(iso + 'T00:00:00');
    const dow = d.getDay();
    const chip = document.createElement('button');
    chip.className  = 'day-chip';
    chip.dataset.date = iso;
    if (dow === 6) chip.classList.add('sat');
    if (dow === 0) chip.classList.add('sun');
    if (iso === currentDate) chip.classList.add('active');
    if (hasDataForDate(serverState.participants, iso)) chip.classList.add('has-data');
    chip.innerHTML = `<span class="chip-date">${d.getDate()}</span><span class="chip-dow">${DOW_KO[dow]}</span>`;
    chip.addEventListener('click', () => switchDate(iso));
    dayChipsEl.appendChild(chip);
  }
}

function updateChipStates() {
  dayChipsEl.querySelectorAll('.day-chip').forEach((chip) => {
    chip.classList.toggle('active',    chip.dataset.date === currentDate);
    chip.classList.toggle('has-data',  hasDataForDate(serverState.participants, chip.dataset.date));
  });
}

function scrollActiveChip() {
  dayChipsEl.querySelector('.day-chip.active')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function switchDate(dateStr) {
  currentDate = dateStr;
  const d = new Date(dateStr + 'T00:00:00');
  currentDayLabel.textContent = `${d.getMonth() + 1}/${d.getDate()}(${DOW_KO[d.getDay()]})`;
  updateChipStates();
  scrollActiveChip();
  grid?.updateAll(getDayView(serverState.participants, currentDate), serverState.names);
  highlightRecForDate(currentDate);
}

function highlightRecForDate(dateStr) {
  grid?.clearRecommended();
  const match = serverState.recommended_slots.find((r) => r.date === dateStr);
  if (match) {
    const slotSet = new Set();
    for (let t = match.start_slot; t < match.end_slot; t++) slotSet.add(t);
    grid?.highlightRecommended(slotSet);
  }
}

// ── Recommendations ──
function renderRecommendations(recs, n) {
  recsContainer.innerHTML = '';
  if (!recs?.length) {
    recsContainer.innerHTML = '<p class="no-recs">과반 이상 겹치는 시간 없음</p>';
    return;
  }

  // Group by date (order preserved — algorithm sends date ASC)
  const byDate = [];
  const dateMap = new Map();
  for (const r of recs) {
    if (!dateMap.has(r.date)) {
      const group = { date: r.date, slots: [] };
      byDate.push(group);
      dateMap.set(r.date, group);
    }
    dateMap.get(r.date).slots.push(r);
  }

  function navigateToSlot(r) {
    showDetailView(r.date);
    const slotSet = new Set();
    for (let t = r.start_slot; t < r.end_slot; t++) slotSet.add(t);
    grid?.highlightRecommended(slotSet);
  }

  for (const { date, slots } of byDate) {
    const d = new Date(date + 'T00:00:00');
    const dlbl = `${d.getMonth() + 1}/${d.getDate()}(${DOW_KO[d.getDay()]})`;

    const group = document.createElement('div');
    group.className = 'date-group';

    const stack = document.createElement('div');
    stack.className = 'date-stack';

    const lbl = document.createElement('div');
    lbl.className = 'date-group-label';
    lbl.innerHTML = `<span>${dlbl}</span>${slots.length > 1 ? '<button class="stack-toggle" aria-label="펼치기/접기">▼</button>' : ''}`;
    if (slots.length > 1) {
      lbl.querySelector('.stack-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        const willExpand = !stack.classList.contains('expanded');
        if (willExpand) {
          stack.classList.add('expanded');
          lbl.classList.add('expanded');
          // Stagger cards 2+ in
          requestAnimationFrame(() => {
            [...stack.querySelectorAll('.stack-card')].slice(1).forEach((card, i) => {
              card.getAnimations().forEach(a => a.cancel());
              card.animate(
                [{ opacity: 0, transform: 'translateY(-10px) scale(0.97)' },
                 { opacity: 1, transform: 'translateY(0) scale(1)' }],
                { duration: 320, delay: i * 70,
                  easing: 'cubic-bezier(0.34,1.2,0.64,1)', fill: 'none' }
              );
            });
          });
        } else {
          // Fade cards out, then collapse
          const cards = [...stack.querySelectorAll('.stack-card')].slice(1);
          let pending = cards.length;
          cards.forEach(card => {
            card.getAnimations().forEach(a => a.cancel());
            const anim = card.animate(
              [{ opacity: 1, transform: 'translateY(0)' },
               { opacity: 0, transform: 'translateY(-6px) scale(0.97)' }],
              { duration: 180, easing: 'ease-in', fill: 'forwards' }
            );
            anim.onfinish = () => {
              if (--pending === 0) {
                stack.classList.remove('expanded');
                lbl.classList.remove('expanded');
                cards.forEach(c => c.getAnimations().forEach(a => a.cancel()));
              }
            };
          });
        }
      });
    }
    group.appendChild(lbl);

    for (const r of slots) {
      const pct    = Math.round(r.attendance_ratio * 100);
      const mins   = r.duration_slots * 30;
      const durStr = mins >= 60 ? `${mins / 60}시간` : `${mins}분`;
      const card   = document.createElement('div');
      card.className = `stack-card rec-card${r.date_rank === 1 ? ' top' : ''}`;
      card.innerHTML = `
        <div class="rec-header">
          <span class="rec-rank">#${r.date_rank}</span>
          <div class="rec-time">${r.start_time}~${r.end_time}</div>
        </div>
        <div class="rec-meta">${r.attendance_count}/${n}명 (${pct}%) · ${durStr}</div>
        <div class="rec-bar"><div class="rec-bar-fill" style="width:${pct}%"></div></div>`;

      card.addEventListener('click', (e) => {
        if (!stack.classList.contains('expanded')) return;
        e.stopPropagation();
        navigateToSlot(r);
      });
      stack.appendChild(card);
    }

    stack.addEventListener('click', () => {
      if (slots.length === 1) { navigateToSlot(slots[0]); return; }
    });

    group.appendChild(stack);
    recsContainer.appendChild(group);
  }
}

// ── WebSocket message handler ──
function handleMessage(msg) {
  const { type, participants = {}, names = {}, recommended_slots = [] } = msg;

  if (['init', 'state_update', 'participant_left'].includes(type)) {
    serverState = { participants, names, recommended_slots };
    const n = Object.keys(participants).length;
    participantCount.textContent = `참여자 ${n}명`;

    if (!calView.hidden) {
      buildCalGrid(participants, recommended_slots);
    } else {
      updateChipStates();
      grid?.updateAll(getDayView(participants, currentDate), names);
      highlightRecForDate(currentDate);
    }
    renderRecommendations(recommended_slots, n);
  }
}

// ── Init ──
function init() {
  ws = new WSClient(roomId, userId, userName, {
    onConnect:    () => statusDot.classList.add('connected'),
    onDisconnect: () => statusDot.classList.remove('connected'),
    onMessage:    handleMessage,
    onNotFound:   () => setTimeout(() => { location.href = '/'; }, 1500),
  });
}

backBtn.addEventListener('click', showCalView);
document.getElementById('select-all-btn').addEventListener('click', () => grid?.selectAll());
document.getElementById('deselect-all-btn').addEventListener('click', () => grid?.deselectAll());
updateCalNav();

if (userId && userName) {
  init();
} else {
  showNameModal(init);
}
