export class WSClient {
  constructor(roomId, userId, name, handlers) {
    this.roomId = roomId;
    this.userId = userId;
    this.name = name;
    this.handlers = handlers;
    this._ws = null;
    this._reconnectDelay = 1000;
    this._closed = false;
    this._connect();
  }

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws/${this.roomId}/${this.userId}?name=${encodeURIComponent(this.name || '')}`;
    this._ws = new WebSocket(url);
    this._ws.onopen = () => { this._reconnectDelay = 1000; this.handlers.onConnect?.(); };
    this._ws.onmessage = (e) => { try { this.handlers.onMessage?.(JSON.parse(e.data)); } catch (_) {} };
    this._ws.onclose = (e) => {
      this.handlers.onDisconnect?.();
      if (e.code === 4004) { this.handlers.onNotFound?.(); return; }
      if (!this._closed && e.code !== 4003) {
        setTimeout(() => this._connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 10000);
      }
    };
    this._ws.onerror = () => {};
  }

  // date: ISO string "YYYY-MM-DD"
  sendSlots(date, slots) { this._send({ type: 'update_slots', date, slots }); }
  leave() { this._closed = true; this._send({ type: 'leave' }); this._ws?.close(); }
  _send(data) { if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(data)); }
  destroy() { this._closed = true; this._ws?.close(); }
}
