# TimeAligner 개발 로그

## 프로젝트 개요
- 회원가입 없는 실시간 모임 시간 조율 앱
- FastAPI + Redis/SQLite/MemoryStore + ES Module 프론트엔드
- WebSocket 실시간 동기화

---

## 기술 스택

**Backend**
- FastAPI (WebSocket + REST)
- Redis → SQLite → MemoryStore 순서로 fallback
- `store.py`: MemoryStore/SQLiteStore 모두 in-process pubsub 구현 (`_PubSubMixin`)
- ROOM_TTL: 90일

**Frontend**
- ES Modules (`type="module"`)
- `grid.js`: TimeGrid 클래스 (48슬롯 × 참여자 컬럼 드래그 그리드)
- `ws.js`: WSClient 클래스 (자동 재연결, exponential backoff)
- `room.js`: 메인 로직 (달력 ↔ 일간 뷰 전환)

---

## 데이터 구조

- 슬롯: 하루 48개 (30분 단위), `[0,1,0,1,...]` 배열
- 날짜: ISO 문자열 `"YYYY-MM-DD"` 키
- Redis 해시:
  - `room:{id}:meta` — timezone, max_participants, created_at
  - `room:{id}:participants` — `{userId: JSON(날짜별슬롯)}`
  - `room:{id}:names` — `{userId: 표시이름}`

---

## 알고리즘 (`algorithm.py`)

- `min_required = n // 2 + 1` (과반수 고정)
- 과거 날짜 제외 (`_date.today()` 기준)
- 점수: `guaranteed³ × duration` (세제곱 참석률 민감도)
- 전참(full attendance) 먼저, 그 다음 부분참석 순
- 날짜별 최대 `_TOP_PER_DATE = 3`개 추천
- 날짜 오름차순 정렬 후 반환

---

## UI 구조

### 달력 뷰 (기본)
- 월별 단일 달력, ‹/› 네비게이션 (-1 ~ +6개월)
- 셀: 겹침 히트맵(마젠타 오버레이), 추천 시간 표시, 내 데이터 체크(✓)
- 날짜 클릭 → 일간 상세 뷰로 전환

### 일간 상세 뷰
- 상단 날짜 칩 스크롤바 (전체 기간)
- 48행 × (나 + 참여자들 + 겹침) 컬럼 드래그 그리드
- 추천 시간대 행 하이라이트 (보라색 테두리)
- 스크롤 없이 뷰포트에 꽉 채움

### 사이드바 (추천 모임 시간)
- 날짜별 그룹핑, 다가오는 순서
- 아이폰 알림 스택: 카드2/3은 하단 peek strip만 렌더 (덮힌 부분 미렌더)
- ▼/▲ 버튼으로 펼치기/접기
- 펼쳤을 때 카드 클릭 → 해당 날짜+슬롯으로 이동

### 스택 CSS 핵심
```css
/* 카드1: 정상 렌더 */
.date-stack:not(.expanded) .stack-card:nth-child(1) { position: relative; z-index: 3; }
/* 카드2: 하단 13px peek strip만 */
.date-stack:not(.expanded) .stack-card:nth-child(2) {
  position: absolute; bottom: 8px; left: 3px; right: 3px; height: 13px;
}
/* 카드3: 더 하단, 더 좁게 */
.date-stack:not(.expanded) .stack-card:nth-child(3) {
  position: absolute; bottom: 0; left: 6px; right: 6px; height: 13px;
}
/* 카드2+ 내용 숨김 */
.date-stack:not(.expanded) .stack-card:nth-child(n+2) * { visibility: hidden; }
```

### 스택 펼치기/접기 애니메이션 (JS Web Animations API)
- CSS `position` 전환은 애니메이션 불가 → JS `Element.animate()` 사용
- **펼칠 때**: `requestAnimationFrame` 후 카드 2+ 순차 등장 (`translateY(-10px)→0`, `opacity 0→1`, stagger 70ms)
- **접을 때**: 카드 페이드아웃 180ms → `onfinish` 콜백에서 `.expanded` 제거 → CSS가 peek strip 복귀
- 화살표 ▼/▲ → CSS `rotate(180deg)` transition (`.date-group-label.expanded .stack-toggle`)

### 선택적 투명성 원칙
- 뒤 카드 덮힌 부분은 렌더링 자체를 안 함 (peek strip만 존재)
- `backdrop-filter`로 페이지 배경은 투과
- 다른 카드 객체는 차단 (fill 불투명도로)

---

## 주요 버그 수정 이력

| 버그 | 원인 | 수정 |
|---|---|---|
| 달력+일간 뷰 동시 표시 | CSS ID 선택자 specificity > `[hidden]` | `[hidden] { display: none !important; }` 추가 |
| 로고 클릭 시 이름 입력 모달 | `location.href = '/'` | `location.reload()` |
| 추천 미표시 | 알고리즘 정상 (recs=2 확인됨), 사용자 혼동 | 디버그 로깅 후 제거 |
| 정원 체크 오작동 | `:participants` 기준 (슬롯 제출자만 카운트) | `:names` 기준으로 수정 |

---

## 개선 이력

### 세션 1
1. **4004 피드백** — WS 방 없음 시 1.5초 후 `/` 자동 리다이렉트
2. **정원 체크** — `:participants` → `:names` 기준
3. **min_attendance 제거** — 저장만 되고 알고리즘에 미사용, 폼/모델/메타에서 삭제
4. **모바일 레이아웃** — 700px 미디어쿼리: 사이드바 아래 스택, 메인패널 `100svh`
5. **데드코드 제거** — `.cal-month-card`, `.room-month-badge` CSS, `leavePermanent()` 메서드
6. **join 방 검증** — 참여 전 `/api/rooms/{id}` API 호출로 존재 확인

### 세션 2
1. **드래그 선택 영역 한정** — `grid.js`: mousedown 시 `document.body.style.userSelect = 'none'` 설정, mouseup 시 복원. CSS `.grid-wrapper { user-select: none }` 추가 → 그리드 밖 드래그 시 텍스트 선택 방지
2. **스택 애니메이션** — JS Web Animations API로 펼치기/접기 부드럽게 (위 참고)
3. **전반 UX 트랜지션 개선** — `day-chip`, `cal-cell`, `rec-card`, `btn-back` hover/active 상태 transition 강화 (duration 증가, `translateY`, `scale` 추가)
4. **개발 환경** — `.claude/launch.json` + `C:\timealigner` junction (한국어 경로 우회) → `preview_start` 연동

### 세션 3
1. **시간대 구분선** — `grid.js`: 슬롯 12/24/36에 `time-section-start` 클래스 + `data-section` 속성 (`오전`/`오후`/`저녁`). CSS `::before` 의사요소로 라벨 렌더, 보라색 2.5px border로 시각 구분
2. **드래그 피드백 강화** — 드래그 중 `.is-dragging` 클래스 → crosshair 커서. 셀 토글 시 `cell-toggled` 클래스 + `cell-pop` 키프레임 애니메이션 (scale 0.82→1.06→1, 180ms)
3. **전체 선택/해제** — `grid.js`에 `selectAll()`/`deselectAll()` 메서드 추가. `room.html` 레전드 옆 `전체 선택`/`전체 해제` 버튼, `room.js`에서 이벤트 연결
4. **달력 겹침 배지** — 추천 없는 날짜에 `N명 참여` 배지 표시 (`.cal-overlap-badge` pill 스타일). 히트맵 + 배지 조합으로 정보 밀도 향상
5. **사이드바 카드 개선** — `.rec-rank` pill 배경 추가, `.rec-bar` 두께 4→5px, border-radius 3px
6. **모바일 사이드바** — `overflow-y: visible` → `auto`, `max-height: 45vh` 추가 → 긴 추천 목록 스크롤 가능
7. **Git 초기화** — `.gitignore` 생성, git init + 초기 커밋, GitHub push (`hoon67/timealigner`)

---

## 남은 고려사항

- `_TOP_PER_DATE = 3` (요청은 5순위였으나 스택 UI상 3이 자연스러움 — 추후 조정 가능)
- SQLite pubsub은 단일 서버에서만 동작 (다중 인스턴스 시 Redis 필수)
- 방 코드만 복사 (전체 URL 아님) — 의도적 설계

---

## 파일 구조

```
timealigner/
├── backend/
│   ├── main.py          # FastAPI 앱, WebSocket 엔드포인트
│   ├── algorithm.py     # 추천 알고리즘
│   ├── models.py        # Pydantic 모델
│   ├── redis_client.py  # 스토어 선택 로직
│   ├── store.py         # SQLiteStore, MemoryStore, pubsub 구현
│   └── requirements.txt
├── frontend/
│   ├── index.html       # 랜딩 (방 만들기/참여)
│   ├── room.html        # 방 페이지
│   ├── css/style.css    # 전체 스타일 (liquid glass)
│   └── js/
│       ├── index.js     # 랜딩 로직
│       ├── room.js      # 방 메인 로직
│       ├── grid.js      # TimeGrid 클래스
│       └── ws.js        # WSClient 클래스
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── run.ps1
└── start_server.bat
```
