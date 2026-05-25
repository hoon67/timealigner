function goToRoom(roomId, name) {
  const userId = crypto.randomUUID();
  sessionStorage.setItem(`name:${roomId}`, name);
  sessionStorage.setItem(`userId:${roomId}`, userId);
  location.href = `/room.html?id=${roomId}`;
}

document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('create-name').value.trim();
  const body = {
    max_participants: +document.getElementById('max-participants').value,
    timezone: document.getElementById('timezone').value,
  };

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = '생성 중…';

  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const { room_id } = await res.json();
    goToRoom(room_id, name);
  } catch (err) {
    alert(`오류: ${err.message}`);
    btn.disabled = false;
    btn.textContent = '방 만들기';
  }
});

document.getElementById('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('join-name').value.trim();
  const roomId = document.getElementById('room-code').value.trim();

  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  btn.textContent = '확인 중…';

  try {
    const res = await fetch(`/api/rooms/${roomId}`);
    if (res.status === 404) throw new Error('존재하지 않는 방 코드입니다');
    if (!res.ok) throw new Error(await res.text());
    goToRoom(roomId, name);
  } catch (err) {
    alert(`오류: ${err.message}`);
    btn.disabled = false;
    btn.textContent = '참여하기';
  }
});
