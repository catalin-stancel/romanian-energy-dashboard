# PowerShell script to start the scheduled data collector
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Romanian Energy Market - Data Collector" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Create logs directory if it doesn't exist
if (!(Test-Path "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
    Write-Host "Created logs directory" -ForegroundColor Green
}

Write-Host "Starting scheduled data collector..." -ForegroundColor Yellow
Write-Host "This will collect data every 15 minutes automatically" -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Ctrl+C to stop the collector" -ForegroundColor Red
Write-Host ""

# Start the scheduled collector
python scheduled_collector.py
