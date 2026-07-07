# HMS 2.0 — Fresh Clone Setup (Windows)

How to run the backend (FastAPI) and the staff frontend (React/Vite) after
cloning the repo on a new Windows machine. macOS/Linux users can use the same
commands — only the prerequisite installers and path separators differ.

The backend uses a local **SQLite** database by default, so **you do not need
Postgres** for local development.

---

## 1. Prerequisites (install once)

Open **PowerShell** and install:

1. **Git** — https://git-scm.com/download/win (or `winget install Git.Git`)
2. **Node.js LTS (20 or 22)** — https://nodejs.org (or `winget install OpenJS.NodeJS.LTS`)
3. **uv** (Python package/venv manager — it will auto-download Python 3.12 for you):

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   ```

   Then **close and reopen PowerShell** so `uv` and `node` are on your PATH.

Verify:

```powershell
git --version
node --version
npm --version
uv --version
```

> You do **not** need to install Python separately. `uv` reads `.python-version`
> (pinned to 3.12) and downloads the correct interpreter automatically.

---

## 2. Clone the repo

```powershell
git clone <your-repo-url> hms-2.0
cd hms-2.0
```

---

## 3. Backend — Terminal 1 (http://127.0.0.1:8000)

```powershell
cd backend
uv sync                                              # creates .venv + installs deps
uv run alembic upgrade head                          # creates the SQLite schema
uv run python -m hms_backend.app.tooling.local_seed  # loads synthetic demo data
uv run uvicorn hms_backend.app.main:app --reload
```

Leave this running. Check it's up:

- Health: http://127.0.0.1:8000/health
- API docs (Swagger): http://127.0.0.1:8000/api/v1/docs

The seed is idempotent — safe to re-run. It loads synthetic customers, assets,
products, reference standards, inspections, pressure tests, and one issued
certificate.

---

## 4. Frontend — Terminal 2 (http://127.0.0.1:5173)

Open a **second** PowerShell window:

```powershell
cd hms-2.0\web\apps\staff
npm install
npm run dev -- --host 127.0.0.1
```

Then open **http://127.0.0.1:5173/** in your browser.

Vite proxies `/api` and `/health` to the backend on port 8000, so start the
backend first. If the backend is down, the UI falls back to built-in mock data.

Auth is dev header scaffolding — no login needed. The UI sends
`X-HMS-Roles: HMS_ADMIN,INSPECTOR,REVIEWER`.

---

## 5. Verify (optional)

Backend tests and linters:

```powershell
cd backend
uv run ruff check . ..\tooling
uv run mypy src tests ..\tooling
uv run pytest
```

Frontend tests and build:

```powershell
cd web\apps\staff
npm test -- --run
npm run build
```

---

## Troubleshooting

- **`uv` or `node` not recognized** — reopen PowerShell (PATH refresh), or
  sign out/in. `winget`-installed tools sometimes need a new shell.
- **`uv sync` fails downloading Python** — you're behind a proxy/firewall that
  blocks GitHub. Install Python 3.12 manually from https://python.org and run
  `uv sync --python 3.12`.
- **Port already in use** — change the port:
  `uv run uvicorn hms_backend.app.main:app --reload --port 8001` (backend) or
  `npm run dev -- --host 127.0.0.1 --port 5174` (frontend). If you move the
  backend port, set `HMS_API_TARGET=http://127.0.0.1:8001` before `npm run dev`.
- **PowerShell script execution blocked** when installing uv — the
  `-ExecutionPolicy ByPass` flag in the install command above handles this.
- **Reset the local database** — stop the backend, delete `backend\hms_dev.db`,
  then re-run the `alembic upgrade head` and seed commands.
