# TimeAligner

TimeAligner is a no-login meeting time coordination app. Participants create a room, share availability in 30-minute slots, and choose from ranked recommendations.

## Run Locally

```powershell
.\run.ps1
```

The app serves the frontend and API from:

```text
http://localhost:8000
```

Check the running server and storage backend:

```powershell
Invoke-RestMethod http://localhost:8000/api/health
```

## Docker

```powershell
docker compose up --build
```

The Docker setup runs Redis and starts the backend with `REQUIRE_REDIS=true`, so deployment fails fast if Redis is unavailable.

## Storage

The backend tries storage in this order:

1. Redis
2. SQLite fallback
3. In-memory fallback

SQLite and in-memory pub/sub only work inside a single server process. Use Redis for multi-instance or production deployments.

## Environment

```text
REDIS_URL=redis://localhost:6379
DB_PATH=timealigner.db
REQUIRE_REDIS=true
```

Set `REQUIRE_REDIS=true` in production to prevent silent fallback to single-process storage.

## Test

```powershell
python -m unittest discover -s tests
python -m py_compile backend\algorithm.py backend\main.py backend\models.py backend\store.py backend\redis_client.py
node --check frontend\js\index.js
node --check frontend\js\room.js
node --check frontend\js\grid.js
node --check frontend\js\ws.js
git diff --check
```
