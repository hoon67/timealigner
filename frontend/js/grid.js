const OVL = '__overlap__';
const TIME_SECTIONS = { 12: '오전', 24: '오후', 36: '저녁' };

export class TimeGrid {
  constructor(containerId, myUserId, myName, onChange) {
    this.container = document.getElementById(containerId);
    this.myUserId = myUserId;
    this.myName = myName;
    this.onChange = onChange;
    this.mySlots = new Array(48).fill(0);
    this.others = {};
    this._isDragging = false;
    this._dragValue = 1;
    this._rows = [];
    this._myCells = [];
    this._overlapCells = [];
    this._bound = false;
    this._build();
    this._bindEvents();
  }

  _colOrder() {
    return [this.myUserId, ...Object.keys(this.others), OVL];
  }

  _makeLabel(text) {
    const el = document.createElement('div');
    el.className = 'time-label';
    el.textContent = text;
    return el;
  }

  _build() {
    this.container.innerHTML = '';
    this.container.className = 'grid-wrapper';
    const order = this._colOrder();

    // ── Header ──
    const hdr = document.createElement('div');
    hdr.className = 'grid-row grid-header-row';
    hdr.appendChild(this._makeLabel(''));

    for (const uid of order) {
      const h = document.createElement('div');
      h.dataset.uid = uid;
      if (uid === OVL) {
        h.className = 'col-header col-header-overlap';
        h.textContent = '겹침';
      } else if (uid === this.myUserId) {
        h.className = 'col-header col-header-me';
        h.textContent = (this.myName || '나') + ' (나)';
      } else {
        h.className = 'col-header';
        h.textContent = this.others[uid]?.name || uid.slice(0, 8);
      }
      hdr.appendChild(h);
    }
    this.container.appendChild(hdr);

    // ── Time rows ──
    this._rows = [];
    this._myCells = [];
    this._overlapCells = [];

    for (let t = 0; t < 48; t++) {
      const row = document.createElement('div');
      row.className = `grid-row${t % 2 === 0 ? ' row-even' : ''}`;
      row.dataset.slot = t;

      if (TIME_SECTIONS[t]) row.classList.add('time-section-start');

      const h = Math.floor(t / 2);
      const m = t % 2 === 0 ? '00' : '30';
      const label = this._makeLabel(t % 2 === 0 ? `${String(h).padStart(2,'0')}:${m}` : '');
      if (TIME_SECTIONS[t]) label.dataset.section = TIME_SECTIONS[t];
      row.appendChild(label);

      for (const uid of order) {
        const cell = document.createElement('div');
        cell.dataset.slot = t;
        cell.dataset.uid = uid;

        if (uid === OVL) {
          cell.className = 'grid-cell overlap-cell';
          this._overlapCells.push(cell);
        } else if (uid === this.myUserId) {
          cell.className = 'grid-cell my-cell';
          if (this.mySlots[t] === 1) cell.classList.add('available');
          this._myCells.push(cell);
        } else {
          cell.className = 'grid-cell other-cell';
          if ((this.others[uid]?.slots[t] ?? 0) === 1) cell.classList.add('available');
        }
        row.appendChild(cell);
      }

      this.container.appendChild(row);
      this._rows.push(row);
    }

    this._updateOverlap();
  }

  _bindEvents() {
    if (this._bound) return;
    this._bound = true;

    const onEnd = () => {
      if (!this._isDragging) return;
      this._isDragging = false;
      this.container.classList.remove('is-dragging');
      document.body.style.userSelect = '';
      this.onChange(this.mySlots.slice());
    };

    this.container.addEventListener('mousedown', (e) => {
      const cell = e.target.closest('.my-cell');
      if (!cell) return;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      const slot = +cell.dataset.slot;
      this._isDragging = true;
      this.container.classList.add('is-dragging');
      this._dragValue = this.mySlots[slot] === 0 ? 1 : 0;
      this._setMySlot(slot, this._dragValue);
    });

    this.container.addEventListener('mouseover', (e) => {
      if (!this._isDragging) return;
      const cell = e.target.closest('.my-cell');
      if (cell) this._setMySlot(+cell.dataset.slot, this._dragValue);
    });

    document.addEventListener('mouseup', onEnd);

    this.container.addEventListener('touchstart', (e) => {
      const el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
      const cell = el?.closest('.my-cell');
      if (!cell) return;
      e.preventDefault();
      const slot = +cell.dataset.slot;
      this._isDragging = true;
      this.container.classList.add('is-dragging');
      this._dragValue = this.mySlots[slot] === 0 ? 1 : 0;
      this._setMySlot(slot, this._dragValue);
    }, { passive: false });

    this.container.addEventListener('touchmove', (e) => {
      if (!this._isDragging) return;
      e.preventDefault();
      const el = document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY);
      const cell = el?.closest('.my-cell');
      if (cell) this._setMySlot(+cell.dataset.slot, this._dragValue);
    }, { passive: false });

    document.addEventListener('touchend', onEnd);
  }

  _setMySlot(slot, value) {
    if (this.mySlots[slot] === value) return;
    this.mySlots[slot] = value;
    const cell = this._myCells[slot];
    if (cell) {
      cell.classList.toggle('available', value === 1);
      cell.classList.remove('cell-toggled');
      void cell.offsetWidth;
      cell.classList.add('cell-toggled');
    }
    this._updateOverlapSlot(slot);
  }

  _updateOverlap() {
    for (let t = 0; t < 48; t++) this._updateOverlapSlot(t);
  }

  _updateOverlapSlot(t) {
    const cell = this._overlapCells[t];
    if (!cell) return;
    const all = [this.mySlots, ...Object.values(this.others).map((o) => o.slots)];
    const total = all.length;
    const count = all.reduce((s, sl) => s + (sl[t] ?? 0), 0);
    cell.style.background = count > 0
      ? `rgba(157,28,191,${((count / total) * 0.75 + 0.15).toFixed(2)})`
      : '';
  }

  // participants: { userId: [48slots] }  (already day-filtered by caller)
  updateAll(participants, names) {
    const prevIds = Object.keys(this.others).sort().join(',');
    const newOtherIds = Object.keys(participants)
      .filter((id) => id !== this.myUserId)
      .sort().join(',');

    if (participants[this.myUserId]) this.mySlots = participants[this.myUserId].slice();

    const newOthers = {};
    for (const [uid, slots] of Object.entries(participants)) {
      if (uid === this.myUserId) continue;
      newOthers[uid] = { name: names?.[uid] || uid.slice(0, 8), slots };
    }

    if (prevIds !== newOtherIds) {
      this.others = newOthers;
      this._build();
      return;
    }

    this.others = newOthers;
    this._myCells.forEach((cell, t) => cell.classList.toggle('available', this.mySlots[t] === 1));
    for (const [uid, { slots }] of Object.entries(newOthers)) {
      this.container.querySelectorAll(`.other-cell[data-uid="${uid}"]`).forEach((cell) => {
        cell.classList.toggle('available', slots[+cell.dataset.slot] === 1);
      });
    }
    this._updateOverlap();
  }

  highlightRecommended(slotSet) {
    this._rows.forEach((row, t) => row.classList.toggle('recommended-row', slotSet.has(t)));
  }

  clearRecommended() {
    this._rows.forEach((r) => r.classList.remove('recommended-row'));
  }

  selectAll() {
    for (let t = 0; t < 48; t++) this._setMySlot(t, 1);
    this.onChange(this.mySlots.slice());
  }

  deselectAll() {
    for (let t = 0; t < 48; t++) this._setMySlot(t, 0);
    this.onChange(this.mySlots.slice());
  }

  getSlots() { return this.mySlots.slice(); }
}
