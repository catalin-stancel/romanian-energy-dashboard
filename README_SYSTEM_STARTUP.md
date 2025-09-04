# Romanian Energy Balancing Market System - Startup Guide

## Current Status ✅
- **Web Dashboard**: Running at http://localhost:8000
- **Data Collection**: Manual (needs automatic collector to be started)
- **Latest Data**: Up to 17:30 (278.69 RON/MWh)

## How to Start the Complete System

### Option 1: Manual Startup (Recommended)

1. **Web Dashboard** (Already Running ✅)
   ```
   python src/web/app.py
   ```
   - Access at: http://localhost:8000
   - Updates display every 10 seconds

2. **Automatic Data Collector** (Start in New Terminal)
   ```
   python scheduled_collector.py
   ```
   - Collects data every 15 minutes
   - Logs to: `logs/scheduled_collector.log`
   - Press Ctrl+C to stop

### Option 2: PowerShell Script
```powershell
.\start_collector.ps1
```

## What the System Does

### Web Dashboard Features:
- ✅ Real-time data display (every 10 seconds)
- ✅ Price and volume charts
- ✅ Market statistics
- ✅ API connection testing
- ✅ Manual data collection buttons

### Automatic Data Collector Features:
- 🔄 **Every 15 minutes**: Collects latest data from ENTSO-E API
- 🔄 **Every hour**: Checks for missed data (2 days back)
- 📝 **Comprehensive logging**: All activities logged
- ⚡ **Force updates**: Always gets the newest available data
- 🌍 **Timezone handling**: Proper UTC to Romanian time conversion

## System Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Web Dashboard │    │ Scheduled        │    │   ENTSO-E API   │
│   (Port 8000)   │◄───┤ Data Collector   │◄───┤  (15min data)   │
│                 │    │ (Every 15min)    │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SQLite Database                              │
│              (balancing_market.db)                              │
└─────────────────────────────────────────────────────────────────┘
```

## Files Created for Automation

- `scheduled_collector.py` - Main automatic data collection script
- `start_collector.ps1` - PowerShell startup script
- `collect_latest_data.py` - One-time data collection script
- `logs/scheduled_collector.log` - Collection activity logs

## Next Steps

1. **Start the automatic collector** in a new terminal:
   ```
   python scheduled_collector.py
   ```

2. **Monitor the logs** to see data collection:
   ```
   tail -f logs/scheduled_collector.log
   ```

3. **Check the dashboard** at http://localhost:8000 to see new data appearing

## Troubleshooting

- **Dashboard not loading**: Make sure `python src/web/app.py` is running
- **No new data**: Check if `scheduled_collector.py` is running
- **API errors**: Check your internet connection and ENTSO-E API status
- **Timezone issues**: All data is automatically converted to Romanian time (UTC+3)

## Success Indicators

✅ **Web Dashboard**: Shows data up to current time intervals
✅ **Data Collector**: Logs show "✅ Scheduled data collection completed successfully"
✅ **Database**: New records appear every 15 minutes
✅ **API Connection**: Green status on dashboard
