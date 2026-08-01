# UENR E-Learning Start Script
# Starts the FastAPI backend and opens the frontend landing page.

Write-Host "--- Starting UENR E-Learning Platform ---" -ForegroundColor Cyan

# 1. Check if the backend is already running on port 8001.
#    Launching a second instance causes a socket error (WinError 10013):
#    "Attempt was made to access a socket in a way forbidden by its access permissions."
$existing = Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Backend is already running on http://localhost:8001 (PID $($existing.OwningProcess)). Skipping launch." -ForegroundColor Green
} else {
    Write-Host "1. Launching FastAPI Backend on http://localhost:8001 ..." -ForegroundColor Yellow
    Start-Process powershell.exe -ArgumentList "-NoExit", "-Command", `
        "cd '$PSScriptRoot\backend'; ..\venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001"

    # 2. Wait a few seconds for the server to initialize
    Start-Sleep -Seconds 3
}

# 3. Open the Frontend Landing Page (requires Live Server on port 5500)
Write-Host "2. Opening Landing Page in Browser..." -ForegroundColor Yellow
Start-Process "http://127.0.0.1:5500/frontend/index.html"

Write-Host "--- System is now Running! ---" -ForegroundColor Green
Write-Host "Backend API docs: http://localhost:8001/docs"
Write-Host "Note: Ensure Live Server is running at port 5500 if the page doesn't load."
