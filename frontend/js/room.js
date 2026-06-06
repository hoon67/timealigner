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
const DOW_KO  = ['일','월','화','수','목','금','토'];

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function localToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function todayInTimezone(timezone) {
  if (!timezone) return localToday();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const part = (type) => parts.find((p) => p.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    if (!year || !month || !day) return localToday();
    return new Date(+year, +month - 1, +day);
  } catch (_) {
    return localToday();
  }
}

let roomTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let TODAY = null;
let CAL_START = null;
let CAL_END = null;
const ALL_DATES = [];

function rebuildDateRange(timezone = roomTimezone) {
  roomTimezone = timezone || roomTimezone;
  TODAY = todayInTimezone(roomTimezone);
  // Calendar range: 1st of (today - 1 month) to last day of (today + 6 months)
  CAL_START = new Date(TODAY.getFullYear(), TODAY.getMonth() - 1, 1);
  CAL_END   = new Date(TODAY.getFullYear(), TODAY.getMonth() + 7, 0);
  ALL_DATES.length = 0;
  for (let d = new Date(CAL_START); d <= CAL_END; d = addDays(d, 1)) {
    ALL_DATES.push(toISO(d));
  }
}
rebuildDateRange();

// ── Modal ──
function showNameModal(cb) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>TimeAligner</h2>
      <p>방 코드: <strong id="modal-room-id"></strong></p>
      <form id="name-form">
        <label>이름<input type="text" id="modal-name" placeholder="홍길동" required maxlength="20" autofocus></label>
        <button type="submit" class="btn-primary">참여하기</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#modal-room-id').textContent = roomId;
  overlay.querySelector('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    userName = overlay.querySelector('#modal-name').value.trim();
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
const finalizedSection = document.getElementById('finalized-section');
const finalizedSlotEl  = document.getElementById('finalized-slot');
const submissionStatusEl = document.getElementById('submission-status');
const recsContainer    = document.getElementById('recommendations');
const roomUrlInput     = document.getElementById('room-url-input');
const copyBtn          = document.getElementById('copy-btn');
const copyLinkBtn      = document.getElementById('copy-link-btn');
const roomTimezoneEl   = document.getElementById('room-timezone');
const participantCount = document.getElementById('participant-count');
const statusDot        = document.getElementById('status-dot');

roomUrlInput.value = roomId;
const inviteUrl = new URL('/room.html', location.origin);
inviteUrl.searchParams.set('id', roomId);

async function copyText(text, button, defaultText) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {}
  if (!ok) {
    const fallback = document.createElement('textarea');
    fallback.value = text;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    try { ok = document.execCommand('copy'); } catch (_) {}
    fallback.remove();
    window.getSelection()?.removeAllRanges();
  }
  button.textContent = ok ? '복사됨!' : '실패';
  button.classList.add('copied');
  if (!ok) alert('복사하지 못했습니다. 방 코드를 직접 선택해서 복사해 주세요.');
  setTimeout(() => { button.textContent = defaultText; button.classList.remove('copied'); }, 2000);
}

copyBtn.addEventListener('click', () => copyText(roomId, copyBtn, '복사'));
copyLinkBtn.addEventListener('click', () => copyText(inviteUrl.toString(), copyLinkBtn, '링크 복사'));

const logoBtn = document.getElementById('logo-btn');
logoBtn.addEventListener('click', () => location.reload());
logoBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    location.reload();
  }
});

// ── Leave button (HTTP DELETE for reliability) ──
document.getElementById('leave-btn').addEventListener('click', async () => {
  if (!confirm('참석자 목록에서 완전히 제거됩니다.\n입력한 가용 시간도 삭제됩니다. 나가시겠습니까?')) return;
  try {
    await fetch(`/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(userId)}`, { method: 'DELETE' });
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
let serverState = {
  participants: {},
  names: {},
  recommended_slots: [],
  meta: {},
  submission_status: null,
  finalized_slot: null,
};
let currentDate = toISO(TODAY);
let calMonthOffset = 0; // -1 to +6 relative to current month

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

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

function formatDuration(mins) {
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    return rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
  }
  return `${mins}분`;
}

function formatTimezone(timezone) {
  const value = timezone || 'UTC';
  const labels = {
    'Asia/Seoul': 'KST',
    'Asia/Tokyo': 'JST',
    'America/New_York': 'ET',
    'Europe/London': 'London',
    UTC: 'UTC',
  };
  return `시간대 ${labels[value] || value}`;
}

function namesPreview(people, emptyText = '없음') {
  if (!people?.length) return emptyText;
  return people.map((p) => escapeHTML(p.name || p)).join(', ');
}

function isSameSlot(a, b) {
  return !!a && !!b && a.date === b.date && a.start_slot === b.start_slot && a.end_slot === b.end_slot;
}

function slotSetFromRange(slot) {
  const slotSet = new Set();
  for (let t = slot.start_slot; t < slot.end_slot; t++) slotSet.add(t);
  return slotSet;
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
    const finalized = serverState.finalized_slot;
    const isFinalized = finalized?.date === iso;
    const topRec = recs.find(r => r.date === iso);

    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.dataset.date = iso;
    if (dow === 6) cell.classList.add('sat');
    if (dow === 0) cell.classList.add('sun');
    if (isToday)   cell.classList.add('today');
    if (isCurrent) cell.classList.add('active');
    if (isFinalized) cell.classList.add('finalized');
    if (hasMe)     cell.classList.add('has-me');
    if (cnt > 0) {
      cell.classList.add('has-data');
      cell.style.setProperty('--overlap-ratio', n > 0 ? cnt / n : 0);
    }

    let recHtml = '';
    if (isFinalized) {
      const finalizedBase = finalized.submitted_count ?? Object.keys(serverState.participants).length;
      recHtml = `<span class="cal-cell-time">확정 ${finalized.start_time}~${finalized.end_time}</span>
                 <span class="cal-cell-att">입력 ${finalized.attendance_count}/${finalizedBase}명 가능</span>`;
    } else if (topRec) {
      const mins = topRec.duration_slots * 30;
      const durStr = formatDuration(mins);
      const submittedBase = topRec.submitted_count ?? n;
      recHtml = `<span class="cal-cell-time">${topRec.start_time}~${topRec.end_time}</span>
                 <span class="cal-cell-att">입력 ${topRec.attendance_count}/${submittedBase}명 · ${durStr}</span>`;
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
  const finalized = serverState.finalized_slot;
  const match = finalized?.date === dateStr
    ? finalized
    : serverState.recommended_slots.find((r) => r.date === dateStr);
  if (match) {
    grid?.highlightRecommended(slotSetFromRange(match));
  }
}

function navigateToSlot(slot) {
  showDetailView(slot.date);
  grid?.highlightRecommended(slotSetFromRange(slot));
}

function renderSubmissionStatus(status) {
  const total = status?.total_count || 0;
  const submitted = status?.submitted_count || 0;
  const pending = status?.pending_count || 0;

  if (total === 0) {
    submissionStatusEl.innerHTML = '<p class="no-recs">참여자 없음</p>';
    return;
  }

  const pct = Math.round((submitted / total) * 100);
  submissionStatusEl.innerHTML = `
    <div class="status-summary">
      <strong>${submitted}/${total}명 입력 완료</strong>
      <span>${pending > 0 ? `${pending}명 대기` : '모두 입력'}</span>
    </div>
    <div class="submission-meter"><div style="width:${pct}%"></div></div>
    <div class="people-block">
      <span class="people-label">완료</span>
      <span>${namesPreview(status.submitted, '아직 없음')}</span>
    </div>
    <div class="people-block">
      <span class="people-label">대기</span>
      <span>${namesPreview(status.pending, '없음')}</span>
    </div>`;
}

function renderFinalizedSlot(slot) {
  if (!slot) {
    finalizedSection.hidden = true;
    finalizedSlotEl.innerHTML = '';
    return;
  }

  finalizedSection.hidden = false;
  const submittedBase = slot.submitted_count ?? Object.keys(serverState.participants).length;
  const pendingText = slot.pending_count ? ` · ${slot.pending_count}명 대기` : '';
  finalizedSlotEl.innerHTML = `
    <div class="finalized-card">
      <div class="finalized-time">${escapeHTML(slot.time_string)}</div>
      <div class="finalized-meta">
        입력자 기준 ${slot.attendance_count}/${submittedBase}명 가능 · ${formatDuration(slot.duration_minutes)}${pendingText}
      </div>
      <div class="people-block">
        <span class="people-label">가능</span>
        <span>${namesPreview(slot.available, '없음')}</span>
      </div>
      <div class="people-block">
        <span class="people-label">불가</span>
        <span>${namesPreview(slot.unavailable, '없음')}</span>
      </div>
      <div class="people-block">
        <span class="people-label">대기</span>
        <span>${namesPreview(slot.pending, '없음')}</span>
      </div>
      <div class="finalized-actions">
        <button class="btn-grid-action" id="view-finalized-btn">보기</button>
        <button class="btn-grid-action danger" id="clear-finalized-btn">해제</button>
      </div>
    </div>`;

  document.getElementById('view-finalized-btn').addEventListener('click', () => navigateToSlot(slot));
  document.getElementById('clear-finalized-btn').addEventListener('click', () => {
    if (confirm('확정 시간을 해제하시겠습니까?')) ws?.clearFinalizedSlot();
  });
}

// ── Recommendations ──
function renderRecommendations(recs, submittedCount) {
  recsContainer.innerHTML = '';
  if (!recs?.length) {
    const mins = +(serverState.meta?.meeting_duration_minutes || 60);
    recsContainer.innerHTML = `<p class="no-recs">${formatDuration(mins)} 이상 과반 겹침 없음</p>`;
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
      const durStr = formatDuration(mins);
      const needStr = formatDuration(r.meeting_duration_minutes || +(serverState.meta?.meeting_duration_minutes || 60));
      const submittedBase = r.submitted_count ?? submittedCount;
      const pendingText = r.pending_count ? ` · ${r.pending_count}명 대기` : '';
      const card   = document.createElement('div');
      const isFinalized = isSameSlot(r, serverState.finalized_slot);
      card.className = `stack-card rec-card${r.date_rank === 1 ? ' top' : ''}${isFinalized ? ' finalized-rec' : ''}`;
      card.innerHTML = `
        <div class="rec-header">
          <span class="rec-rank">#${r.date_rank}</span>
          <div class="rec-time">${r.start_time}~${r.end_time}</div>
          <button class="btn-finalize" type="button">${isFinalized ? '확정됨' : '확정'}</button>
        </div>
        <div class="rec-meta">입력자 기준 ${r.attendance_count}/${submittedBase}명 (${pct}%) · ${durStr} 가능 · ${needStr} 필요${pendingText}</div>
        <div class="rec-reason">
          <div><strong>가능</strong><span>${namesPreview(r.available, '없음')}</span></div>
          <div><strong>불가</strong><span>${namesPreview(r.unavailable, '없음')}</span></div>
          <div><strong>대기</strong><span>${namesPreview(r.pending, '없음')}</span></div>
        </div>
        <div class="rec-bar"><div class="rec-bar-fill" style="width:${pct}%"></div></div>`;

      card.querySelector('.btn-finalize').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isFinalized && confirm(`${r.time_string}으로 확정하시겠습니까?`)) ws?.finalizeSlot(r);
      });

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
  const {
    type,
    participants = {},
    names = {},
    recommended_slots = [],
    meta = serverState.meta,
    submission_status = serverState.submission_status,
    finalized_slot = serverState.finalized_slot,
  } = msg;

  if (['init', 'state_update', 'participant_left', 'finalized_slot_update'].includes(type)) {
    const previousToday = toISO(TODAY);
    const nextTimezone = meta?.timezone || roomTimezone;
    let dateRangeChanged = false;
    if (nextTimezone !== roomTimezone) {
      const wasShowingToday = currentDate === previousToday;
      rebuildDateRange(nextTimezone);
      if (wasShowingToday) currentDate = toISO(TODAY);
      dateRangeChanged = true;
    }

    serverState = { participants, names, recommended_slots, meta, submission_status, finalized_slot };
    const total = submission_status?.total_count ?? Object.keys(names).length;
    const submitted = submission_status?.submitted_count ?? Object.keys(participants).length;
    roomTimezoneEl.textContent = formatTimezone(meta?.timezone);
    participantCount.textContent = `참여자 ${total}명 · 입력 ${submitted}/${total}`;

    if (!calView.hidden) {
      buildCalGrid(participants, recommended_slots);
    } else {
      if (dateRangeChanged) {
        buildDayChips();
        scrollActiveChip();
      } else {
        updateChipStates();
      }
      grid?.updateAll(getDayView(participants, currentDate), names);
      highlightRecForDate(currentDate);
    }
    renderSubmissionStatus(submission_status);
    renderFinalizedSlot(finalized_slot);
    renderRecommendations(recommended_slots, submitted);
  }
}

// ── Init ──
function init() {
  ws = new WSClient(roomId, userId, userName, {
    onConnect:    () => statusDot.classList.add('connected'),
    onDisconnect: () => statusDot.classList.remove('connected'),
    onMessage:    handleMessage,
    onNotFound:   () => {
      alert('방을 찾을 수 없습니다. 삭제되었거나 만료된 방일 수 있습니다.');
      sessionStorage.removeItem(`name:${roomId}`);
      sessionStorage.removeItem(`userId:${roomId}`);
      location.href = '/';
    },
    onFull:       () => {
      alert('이 방은 정원이 가득 찼습니다.');
      sessionStorage.removeItem(`name:${roomId}`);
      sessionStorage.removeItem(`userId:${roomId}`);
      location.href = '/';
    },
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
