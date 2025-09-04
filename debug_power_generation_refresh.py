#!/usr/bin/env python3

import sqlite3
from datetime import datetime, timedelta
import pytz

def check_power_generation_data():
    """Check the current status of power generation data in the database"""
    
    # Connect to database
    conn = sqlite3.connect('data/balancing_market.db')
    cursor = conn.cursor()
    
    # Get current time in Bucharest timezone
    bucharest_tz = pytz.timezone('Europe/Bucharest')
    now = datetime.now(bucharest_tz)
    current_interval = now.replace(minute=(now.minute // 15) * 15, second=0, microsecond=0)
    
    print(f"🕐 Current time: {now}")
    print(f"🎯 Current interval: {current_interval}")
    print()
    
    # Get all tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    
    print("📊 Available tables:")
    for table in tables:
        print(f"  - {table[0]}")
    print()
    
    # Check power_generation_data table schema
    try:
        cursor.execute("PRAGMA table_info(power_generation_data)")
        columns = cursor.fetchall()
        
        print("🏗️ Power Generation Data Table Schema:")
        for col in columns:
            print(f"  Column: {col[1]}, Type: {col[2]}")
        print()
        
        # Get latest records
        cursor.execute("SELECT * FROM power_generation_data ORDER BY timestamp DESC LIMIT 5")
        results = cursor.fetchall()
        
        print("📈 Latest 5 power generation records:")
        if results:
            for i, row in enumerate(results, 1):
                print(f"  {i}. {row}")
        else:
            print("  ❌ No records found!")
        print()
        
        # Check how recent the latest data is
        if results:
            latest_record = results[0]
            latest_timestamp = latest_record[1]  # timestamp is second column (index 1)
            latest_updated_at = latest_record[18]  # updated_at is at index 18
            
            print(f"🔍 Latest data timestamp: {latest_timestamp}")
            print(f"🔍 Latest updated_at: {latest_updated_at}")
            
            # Parse the updated_at timestamp and compare with current time
            try:
                if '+' in latest_updated_at:
                    latest_dt = datetime.fromisoformat(latest_updated_at)
                else:
                    latest_dt = datetime.fromisoformat(latest_updated_at.replace(' ', 'T') + '+03:00')
                
                time_diff = now - latest_dt
                print(f"⏰ Time since last update: {time_diff}")
                
                if time_diff.total_seconds() > 300:  # More than 5 minutes
                    print("⚠️  WARNING: Power generation data appears stale!")
                    print(f"   Last update was {time_diff} ago")
                else:
                    print("✅ Power generation data is recent")
            except Exception as e:
                print(f"❌ Error parsing timestamp: {e}")
                print(f"   Raw updated_at value: {latest_updated_at}")
        
    except Exception as e:
        print(f"❌ Error accessing power_generation_data: {e}")
    
    conn.close()

if __name__ == "__main__":
    check_power_generation_data()
