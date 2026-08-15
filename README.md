# UENR Interactive E-Learning Platform
> Design and Implementation of an Interactive E-Learning Platform with Real-Time Feedback Mechanism

---

## Project Overview
An intelligent web-based e-learning platform that monitors student engagement and comprehension in real-time using a Two-Tower Neural Network, generates micro-questions for at-risk students, auto-generates AI assignments from course materials, and recommends external learning resources.

## User Roles
| Role | Description |
|------|-------------|
| **Student** | Access materials, answer quizzes/micro-questions, complete AI-generated assignments, receive personalized recommendations, message lecturers, track engagement and progress |
| **Lecturer** | Upload materials, monitor students in real-time, publish resources, create quizzes and assignments, message students, view analytics dashboards |
| **HOD** | Monitor departmental analytics and courses, identify at-risk students early, create courses and quizzes |

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JavaScript (no framework) |
| Backend | Python, FastAPI, Uvicorn |
| ML Model | TensorFlow Two-Tower Neural Network (engagement/comprehension classification) |
| AI Generation | Google Gemini + Groq fallback (quiz & assignment generation) |
| Recommendations | YouTube Data API v3 + curated resource catalog |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth + JWT Bearer Tokens |
| Storage | Supabase Storage (materials, avatars) |
| Design System | Shared CSS variables, light/dark theme, responsive breakpoints |
| Hosting | Render (FastAPI web service) + Vercel (static frontend) |

## Project Structure
```
FYP/
├── frontend/                     # Frontend application
│   ├── shared/                   # Shared design system & components
│   │   ├── variables.css         # CSS design tokens (colors, spacing, typography)
│   │   ├── reset.css             # CSS reset + base polish
│   │   ├── typography.css        # Shared typography + utilities
│   │   ├── responsive.css        # Mobile/tablet breakpoints (incl. off-canvas drawer)
│   │   ├── sidebar.css + sidebar.js  # Shared sidebar (all roles): injected nav, unread badges, mobile drawer
│   │   ├── dropdown.css + dropdown.js # Custom dropdown/select component
│   │   ├── pulse.css             # Real-time engagement pulse bar
│   │   ├── spinner.css           # Loading spinners, skeletons, button loaders
│   │   ├── toast.css + toast.js  # Toast notifications (success/error/warning/info)
│   │   ├── profile-popup.css + profile-popup.js # Profile popup with avatar upload
│   │   ├── theme.js              # Light/dark theme toggle (localStorage)
│   │   └── session.js            # Auth session, token refresh, role guards, nav badges
│   ├── auth/                     # Login & Register (validation, confirm password, auto-login)
│   ├── student/                  # Dashboard, assignments, inbox, progress, study aids
│   ├── courses/                  # Course catalog & enrollment (avatar + profile popup)
│   ├── materials/                # Material viewer (engagement tracking + micro-questions)
│   ├── quiz/                     # Quiz taking interface (incl. AI-generated quizzes)
│   ├── results/                  # Quiz results page
│   ├── analytics/                # Student performance analytics (avatar + profile popup)
│   ├── recommendations/          # AI-powered recommendations + AI tutor Q&A
│   ├── lecturer/                 # Dashboard, study press, my courses, assignments, quiz creation, upload
│   ├── hod/                      # Dashboard, department course hub, course & quiz creation
│   ├── css/                      # Landing page styles
│   ├── image/                    # Static images (logo, etc.)
│   └── index.html                # Landing page
├── backend/                      # FastAPI backend
│   ├── app/
│   │   ├── main.py               # App entry point, CORS, routers
│   │   ├── core/
│   │   │   ├── config.py         # Environment settings (backend/.env)
│   │   │   └── security.py       # JWT auth, role-based access (get_current_user, require_role)
│   │   ├── database.py           # Supabase client (admin + anon)
│   │   ├── routes/
│   │   │   ├── auth.py           # Register, login, token refresh
│   │   │   ├── courses.py        # Course CRUD, enrollment
│   │   │   ├── materials.py      # Material upload, listing, proxy (SSRF-protected)
│   │   │   ├── engagement.py     # Telemetry logging, Two-Tower classification
│   │   │   ├── analytics.py      # Lecturer, HOD & study analytics
│   │   │   ├── study.py          # Per-student study summary
│   │   │   ├── quiz.py           # Quiz creation, submission, results
│   │   │   ├── assignments.py    # AI assignment creation, submission, pending-count
│   │   │   ├── micro_questions.py # Auto-generated comprehension checks
│   │   │   ├── recommendations.py # AI resource recommendations
│   │   │   ├── resources.py      # Resource catalog (generate/publish/list)
│   │   │   ├── messages.py       # Inbox, unread count, read receipts
│   │   │   ├── attendance.py     # Attendance logging
│   │   │   ├── users.py          # Profile update, avatar upload
│   │   │   └── students.py       # Student listing for lecturers/HODs
│   │   ├── schemas/              # Pydantic request/response models
│   │   └── services/
│   │       ├── engagement_analyzer.py  # Two-Tower NN inference
│   │       ├── recommendation_engine.py # Recommendation logic
│   │       ├── quiz_generator.py       # Gemini/Groq quiz & assignment generation
│   │       ├── youtube_service.py      # YouTube Data API integration
│   │       ├── material_content.py     # Material content extraction
│   │       └── grades.py               # Grade computation
│   ├── .env.example              # Backend environment template
│   └── requirements.txt
├── ml/                           # ML inference code & trained model
│   ├── src/                      # Model inspection & inference scripts
│   └── models/                   # Trained model artifacts (e.g. student_engagement_model.keras)
├── supabase/                     # Database migrations (SQL) & seed data
├── .env.example                  # Root environment template
├── requirements.txt              # Root redirect → backend/requirements.txt (Render default)
├── render.yaml                   # Render Blueprint (backend web service)
├── vercel.json                   # Vercel config (frontend output directory)
├── Dockerfile                    # Container image (host-safe dependency set)
└── start.ps1                     # Quick-start script
```

## Getting Started

### Prerequisites
- Python 3.10+ and pip
- PowerShell on Windows
- VS Code with the Live Server extension (recommended)
- A Supabase project (see below)

### 1. Create and activate a virtual environment
```powershell
py -3 -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

### 2. Install dependencies
```powershell
pip install -r backend/requirements.txt
```
Optionally install the heavy ML packages (Two-Tower model, semantic search) for local use:
```powershell
pip install -r backend/requirements-ml.txt
```
The app runs without them (heuristic + TF-IDF fallbacks); the ML flags in `backend/.env` control which path is used.

### 3. Configure environment variables
```powershell
Copy-Item backend\.env.example backend\.env
```
Fill in `backend/.env` with your Supabase project URL and keys (Project Settings → API). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required; `GEMINI_API_KEY`, `GROQ_API_KEY`, and `YOUTUBE_API_KEY` enable AI quiz/assignment generation and live video recommendations (leave empty for fallbacks).

### 4. Run the backend
```powershell
.\venv\Scripts\Activate.ps1
cd backend
python -m uvicorn app.main:app --reload --port 8001
```
- API docs: http://localhost:8001/docs
- Health check: http://localhost:8001/api/health

### 5. Run the frontend
Open `frontend/index.html` with Live Server in VS Code, or:
```powershell
python -m http.server 5500
```
Then visit http://127.0.0.1:5500/frontend/index.html

### Quick start
```powershell
.\start.ps1
```
Starts the backend (skips if already running on port 8001) and opens the landing page.

## Deployment

### Backend — Render
- Import the repo into Render as a Web Service (or use the included `render.yaml` blueprint).
- Build command: `pip install -r backend/requirements.txt`
- Start command: `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
- Set these in the Render dashboard (the blueprint marks them `sync: false`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CORS_ORIGINS`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `YOUTUBE_API_KEY`. The last three are optional: without them AI quiz/assignment generation and the AI tutor degrade (mock/empty fallbacks) and live YouTube search is skipped (the curated pool still works).
- Heavy ML packages (TensorFlow, Sentence Transformers, XGBoost) live in `backend/requirements-ml.txt` and are **not** installed on the free tier. The app auto-falls back to the heuristic engagement analyzer and hand-rolled TF-IDF search; flip `ENGAGEMENT_ML_ENABLED` / `SEMANTIC_SEARCH_ENABLED` to `true` on a larger instance.
- Smoke check: `GET https://<your-service>.onrender.com/api/health`

### Frontend — Vercel
- Import the repo; set **Output Directory** to `frontend` (see `vercel.json`) and Framework to *Other* — no build step needed, it's a static site.
- The API base URL is resolved in `frontend/shared/session.js`: `http://localhost:8001` on `localhost`/`127.0.0.1`, otherwise `https://uenr-elearning-api.onrender.com`. Edit this line if your Render service URL differs.

> **Security note:** real credentials never live in the repo. `backend/.env` is gitignored; all `.env.example` files contain placeholders only.

## Key Features

### Engagement Tracking
- Tracks mouse movements, scroll depth, clicks, time-spent, and idle time
- Detects tab visibility changes and window focus/blur
- Dual scoring formula: regular content vs embedded content (PDFs, Office docs)
- Engagement pulse bar shows real-time activity level

### Two-Tower Neural Network
- **Student Tower**: 9 demographic features (age, sex, education, etc.)
- **Interaction Tower**: 6 behavioral features (grades, absences, failures)
- Classifies students into At-Risk / Moderate / Highly Engaged
- Also classifies comprehension level (Low / Moderate / Good)
- Auto-classify endpoint bridges telemetry logs with ML inference
- Lazy-loads the model and falls back to a heuristic analyzer when `ENGAGEMENT_ML_ENABLED=false`

### Micro-Questions
- Auto-generated when a student is classified as At-Risk
- Multiple-choice questions with hints; difficulty adapts to performance
- Results update engagement classification in real-time

### AI Assignments
- Auto-generated per student from course materials (Gemini/Groq)
- "Download a material to unlock your assignment" flow; pending-count badge on the sidebar
- Students submit text answers; on-time status is tracked automatically against the due date
- Lecturers review per-student submissions with on-time/overdue status
- Submission tracking with on-time status and average grade
- Assignment Performance section in the student analytics dashboard

### AI Quizzes
- Quiz creation with manual or AI-generated questions (Gemini/Groq)
- Instant grading and per-question feedback
- Weak-topic detection feeds the recommendation engine

### Study Resources ("The Study Press")
- Lecturers feed an uploaded material through the press and generate a **summary**, **key points**, or **practice questions** (Gemini/Groq)
- Proof the AI output, then publish it to a course; students see it under **Study Aids** on their dashboard
- Published resources can be removed by the lecturer (styled confirmation modal)
- Student visibility is scoped by course enrollment; lecturers/HODs by course ownership/department

### Recommendations
- Takes weak concepts (from quiz history) as input
- Recommends YouTube tutorials (YouTube Data API), articles, and study materials
- Curated resource catalog that lecturers can generate and publish per course
- Auto-detected weak-topic chips surface in the search box on page load
- Fast retrieval: weak-topic auto-detection searches only the local pool, and the
  live YouTube search runs concurrently behind a short timeout so it never stacks
  on top of pool latency
- AI tutor: in-page Q&A grounded in the selected course's material content

### Messaging & Attendance
- Student ↔ lecturer inbox with unread-count badges
- Attendance logging per student

### Design System
- **Dark mode** (default) and **light mode** toggle
- CSS custom properties for all tokens (colors, spacing, typography, shadows)
- Responsive breakpoints: 772px (collapsed icon sidebar), 560px (off-canvas drawer), 400px (compact)
- Shared sidebar across all roles: injected nav with icons/labels, unread-count badges,
  hamburger toggle that slides the sidebar in as a drawer on mobile
- Profile avatar + popup with avatar upload on every authenticated page
- Shared custom dropdown and pulse components across all roles
- Toast notifications, loading spinners, skeleton placeholders, button loaders

### Security
- JWT bearer token authentication via Supabase
- Role-based access control (student, lecturer, HOD)
- Students can only access their own data
- Quiz/assignment submission authorization (prevents submitting as another student)
- SSRF protection on the material proxy endpoint
- Real credentials live only in the gitignored `backend/.env`

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | No | Register a new user |
| POST | `/api/auth/login` | No | Login and get tokens |
| POST | `/api/auth/refresh` | No | Refresh access token |
| GET | `/api/courses/` | Yes | List all courses |
| POST | `/api/courses/enroll` | Yes | Enroll in a course |
| POST | `/api/materials/upload` | Lecturer/HOD | Upload course material |
| GET | `/api/materials/course/{id}` | Yes | Get course materials |
| GET | `/api/materials/proxy` | Yes | Proxy Supabase storage file |
| POST | `/api/engagement/log` | Yes | Log student engagement metrics |
| POST | `/api/engagement/classify` | Yes | Run Two-Tower classification |
| POST | `/api/engagement/auto-classify` | Yes | Auto-classify from telemetry |
| GET | `/api/engagement/student/{id}` | Yes | Get student engagement logs |
| GET | `/api/analytics/course/{id}/summary` | Yes | Course engagement summary |
| GET | `/api/analytics/department/summary` | HOD | Department-wide analytics |
| GET | `/api/study/summary/{id}` | Yes | Per-student study & progress summary |
| POST | `/api/quiz/create` | Lecturer | Create a quiz with questions |
| POST | `/api/quiz/submit` | Yes | Submit quiz attempt |
| GET | `/api/quiz/course/{id}` | Yes | Get quizzes for a course |
| POST | `/api/assignments/create` | Lecturer | Create an assignment |
| POST | `/api/assignments/auto-generate` | Lecturer | Auto-generate AI assignments |
| GET | `/api/assignments/pending-count` | Student | Count of pending AI assignments |
| GET | `/api/assignments/course/{course_id}` | Yes | Assignments for a course |
| POST | `/api/assignments/submit` | Yes | Submit an assignment |
| GET | `/api/assignments/{assignment_id}/submissions` | Lecturer | View submissions |
| POST | `/api/micro-questions/generate` | Yes | Generate micro-questions |
| POST | `/api/micro-questions/verify` | Yes | Verify micro-question answers |
| POST | `/api/recommendations/` | Student | Get ranked resource recommendations for weak concepts |
| GET | `/api/recommendations/auto` | Student | Auto-detect weak topics + pooled recommendations |
| POST | `/api/recommendations/ask` | Student | AI tutor Q&A (optionally course-grounded) |
| GET | `/api/recommendations/notifications` | Student | Unread auto-generated recommendations |
| POST | `/api/recommendations/notifications/read` | Student | Mark recommendation notifications as read |
| POST | `/api/resources/generate` | Yes | Generate a study resource |
| POST | `/api/resources/publish` | Lecturer | Publish a resource to a course |
| GET | `/api/resources/course/{course_id}` | Yes | Resources for a course |
| DELETE | `/api/resources/{resource_id}` | Lecturer | Delete a resource |
| POST | `/api/messages/send` | Yes | Send a message |
| GET | `/api/messages/inbox` | Yes | Get inbox messages |
| GET | `/api/messages/unread-count` | Yes | Count unread messages |
| POST | `/api/messages/read/{message_id}` | Yes | Mark a message as read |
| POST | `/api/attendance/log` | Lecturer | Log attendance |
| GET | `/api/attendance/student/{student_id}` | Yes | Get attendance records |
| POST | `/api/users/profile/avatar` | Yes | Upload profile avatar |

## License
University of Energy and Natural Resources — Final Year Project 2025/2026
