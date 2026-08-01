# UENR Interactive E-Learning Platform
> Design and Implementation of an Interactive E-Learning Platform with Real-Time Feedback Mechanism

---

## Project Overview
An intelligent web-based e-learning platform that monitors student engagement and comprehension in real-time using a Two-Tower Neural Network, generates micro-questions for at-risk students, and recommends external learning resources.

## User Roles
| Role | Description |
|------|-------------|
| **Student** | Access materials, answer quizzes/micro-questions, receive personalized recommendations, track engagement |
| **Lecturer** | Upload materials, monitor students in real-time, assign quizzes, view analytics dashboards |
| **HOD** | Monitor departmental analytics, course performance reports, identify at-risk students early |

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JavaScript (no framework) |
| Backend | Python, FastAPI, Uvicorn |
| ML Model | TensorFlow Two-Tower Neural Network (engagement/comprehension classification) |
| Database | Supabase (PostgreSQL) |
| Auth | Supabase Auth + JWT Bearer Tokens |
| Storage | Supabase Storage (materials, avatars) |
| Design System | Shared CSS variables, light/dark theme, responsive breakpoints |

## Project Structure
```
FYP/
├── frontend/                     # Frontend application
│   ├── shared/                   # Shared design system & components
│   │   ├── variables.css         # CSS design tokens (colors, spacing, typography)
│   │   ├── reset.css             # CSS reset + base polish
│   │   ├── typography.css        # Shared typography + utilities (badges, glass, animations)
│   │   ├── responsive.css        # Mobile/tablet breakpoints (772px, 560px, 400px)
│   │   ├── sidebar.css           # Shared sidebar component (all roles)
│   │   ├── spinner.css           # Loading spinners, skeletons, button loaders
│   │   ├── toast.css             # Toast notification styles
│   │   ├── profile-popup.css     # Profile popup overlay styles
│   │   ├── theme.js              # Light/dark theme toggle (localStorage)
│   │   ├── session.js            # Auth session management, token refresh, role guards
│   │   ├── profile-popup.js      # Profile popup with avatar upload
│   │   └── toast.js              # Toast notification system (success/error/warning/info)
│   ├── auth/                     # Login & Register pages
│   ├── student/                  # Student dashboard
│   ├── courses/                  # Course catalog & enrollment
│   ├── materials/                # Material viewer (engagement tracking + micro-questions)
│   ├── quiz/                     # Quiz taking interface
│   ├── results/                  # Quiz results page
│   ├── analytics/                # Student performance analytics
│   ├── recommendations/          # AI-powered recommendations
│   ├── lecturer/                 # Lecturer dashboard, upload, quiz creation
│   ├── hod/                      # HOD dashboard, department analytics, course creation
│   ├── css/                      # Index page styles (base/, components/, pages/)
│   └── index.html                # Landing page
├── backend/                      # FastAPI backend
│   ├── app/
│   │   ├── main.py               # App entry point, CORS, routers
│   │   ├── core/
│   │   │   ├── config.py         # Environment settings (.env)
│   │   │   └── security.py       # JWT auth, role-based access (get_current_user, require_role)
│   │   ├── database.py           # Supabase client (admin + anon)
│   │   ├── routes/
│   │   │   ├── auth.py           # Register, login, token refresh
│   │   │   ├── courses.py        # Course CRUD, enrollment
│   │   │   ├── materials.py      # Material upload, listing, proxy (SSRF-protected)
│   │   │   ├── engagement.py     # Telemetry logging, Two-Tower classification
│   │   │   ├── analytics.py      # Lecturer & HOD analytics endpoints
│   │   │   ├── quiz.py           # Quiz creation, submission, results
│   │   │   ├── recommendations.py # AI resource recommendations
│   │   │   ├── micro_questions.py # Auto-generated comprehension checks
│   │   │   ├── users.py          # Profile update, avatar upload
│   │   │   └── students.py       # Student listing for lecturers/HODs
│   │   ├── schemas/              # Pydantic request/response models
│   │   └── services/
│   │       ├── engagement_analyzer.py  # Two-Tower NN inference
│   │       └── recommendation_engine.py # Recommendation logic
│   └── requirements.txt
├── ml/                           # ML training notebooks & datasets
├── supabase/                     # Database migrations (SQL)
└── start.ps1                     # Quick-start script
```

## Getting Started

### Prerequisites
- Python 3.10+ and pip
- PowerShell on Windows
- VS Code with the Live Server extension (recommended)

### 1. Create and activate a virtual environment
```powershell
py -3 -m venv venv
.\venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
```

### 2. Install dependencies
```powershell
pip install -r backend/requirements.txt
pip install -r ml/requirements.txt
```

### 3. Configure environment variables
```powershell
Copy-Item .env.example .env
```
Update the values in `.env` if needed. The example file contains the default Supabase credentials for local development.

### 4. Run the backend
```powershell
 c:/Users/myPC/Desktop/FYP/venv/Scripts/Activate.ps1
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

### Micro-Questions
- Auto-generated when a student is classified as At-Risk
- 3 multiple-choice questions per session with hints
- Difficulty adapts based on previous performance
- Results update engagement classification in real-time

### Recommendations
- Takes weak concepts as input
- Recommends YouTube tutorials, articles, and study materials
- Personalized based on engagement history and course content

### Design System
- **Dark mode** (default) and **light mode** toggle
- CSS custom properties for all tokens (colors, spacing, typography, shadows)
- Responsive breakpoints: 772px (tablet sidebar), 560px (mobile bottom nav), 400px (compact)
- Shared sidebar component across all roles
- Toast notifications (success/error/warning/info)
- Loading spinners, skeleton placeholders, button loaders
- Profile popup with avatar upload

### Security
- JWT bearer token authentication via Supabase
- Role-based access control (student, lecturer, HOD)
- Students can only access their own data
- Quiz submission authorization (prevents submitting as another student)
- SSRF protection on material proxy endpoint
- SSL bypass conditional on `APP_ENV=development`

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
| POST | `/api/quiz/create` | Lecturer | Create a quiz with questions |
| POST | `/api/quiz/submit` | Yes | Submit quiz attempt |
| GET | `/api/quiz/course/{id}` | Yes | Get quizzes for a course |
| POST | `/api/micro-questions/generate` | Yes | Generate micro-questions |
| POST | `/api/micro-questions/verify` | Yes | Verify micro-question answers |
| POST | `/api/recommendations/generate` | Yes | Get AI recommendations |
| POST | `/api/users/profile/avatar` | Yes | Upload profile avatar |

## License
University of Energy and Natural Resources — Final Year Project 2025/2026
