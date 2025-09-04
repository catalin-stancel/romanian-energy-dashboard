@echo off
echo ========================================
echo Romanian Energy Balancing Market System
echo ========================================
echo.
echo Starting system components...
echo.

REM Create logs directory if it doesn't exist
if not exist "logs" mkdir logs

echo [1/2] Starting Web Dashboard...
start "Web Dashboard" cmd /k "python src/web/app.py"

echo [2/2] Starting Scheduled Data Collector...
start "Data Collector" cmd /k "python scheduled_collector.py"

echo.
echo ========================================
echo System Started Successfully!
echo ========================================
echo.
echo Web Dashboard: http://localhost:8000
echo Data Collector: Running every 15 minutes
echo.
echo Press any key to close this window...
pause >nul
