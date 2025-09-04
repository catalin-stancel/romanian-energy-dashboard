#!/usr/bin/env python3
"""
Investigate database inconsistencies in power generation data.
This script will examine the database directly to understand:
1. What intervals are missing
2. Why early morning intervals have zero imports/exports
3. What the actual stored values look like vs expected values
"""

import sqlite3
import requests
from datetime import datetime, timedelta
import json

def get_database_connection():
    """Get database connection"""
    return sqlite3.connect('data/balancing_market.db')

def examine_database_structure():
    """Examine the database structure and content"""
    print("🔍 EXAMINING DATABASE STRUCTURE")
    print("=" * 50)
    
    conn = get_database_connection()
    cursor = conn.cursor()
    
    # Get table schema
    cursor.execute("PRAGMA table_info(power_generation_data)")
    columns = cursor.fetchall()
    print("📋 Table Schema:")
    for col in columns:
        print(f"  - {col[1]} ({col[2]})")
    
    # Get total record count
    cursor.execute("SELECT COUNT(*) FROM power_generation_data")
    total_count = cursor.fetchone()[0]
    print(f"\n📊 Total records in database: {total_count}")
    
    # Get date range
    cursor.execute("SELECT MIN(timestamp), MAX(timestamp) FROM power_generation_data")
    min_date, max_date = cursor.fetchone()
    print(f"📅 Date range: {min_date} to {max_date}")
    
    conn.close()

def examine_todays_data():
    """Examine today's data in detail"""
    print("\n🔍 EXAMINING TODAY'S DATA")
    print("=" * 50)
    
    conn = get_database_connection()
    cursor = conn.cursor()
    
    today = datetime.now().strftime('%Y-%m-%d')
    
    # Get all records for today
    cursor.execute("""
        SELECT timestamp, total_production, total_consumption, imports, exports, net_balance 
        FROM power_generation_data 
        WHERE DATE(timestamp) = ? 
        ORDER BY timestamp
    """, (today,))
    
    records = cursor.fetchall()
    print(f"📊 Found {len(records)} records for today ({today})")
    
    if records:
        print("\n📋 Sample of stored data:")
        print("Time        | Prod  | Cons  | Import| Export| Net   ")
        print("-" * 55)
        
        zero_import_export_count = 0
        for i, record in enumerate(records):
            timestamp, prod, cons, imports, exports, net = record
            time_part = timestamp.split()[1][:5]  # Extract HH:MM
            
            # Count zero import/export records
            if imports == 0 and exports == 0:
                zero_import_export_count += 1
            
            # Show first 10, last 10, and some middle records
            if i < 10 or i >= len(records) - 10 or i % 10 == 0:
                print(f"{time_part}       | {prod:5.0f} | {cons:5.0f} | {imports:6.0f}| {exports:6.0f}| {net:6.0f}")
        
        print(f"\n⚠️  Records with zero imports AND exports: {zero_import_export_count}/{len(records)}")
        
        # Analyze patterns
        print("\n🔍 ANALYZING PATTERNS:")
        
        # Check for missing intervals (should be every 15 minutes)
        expected_intervals = []
        start_time = datetime.strptime(f"{today} 00:00:00", "%Y-%m-%d %H:%M:%S")
        for i in range(96):  # 24 hours * 4 intervals per hour
            expected_intervals.append(start_time + timedelta(minutes=i*15))
        
        actual_timestamps = []
        for r in records:
            timestamp_str = r[0]
            # Handle timestamps with microseconds
            if '.' in timestamp_str:
                timestamp_str = timestamp_str.split('.')[0]
            actual_timestamps.append(datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S"))
        missing_intervals = []
        
        for expected in expected_intervals:
            if expected not in actual_timestamps:
                missing_intervals.append(expected)
        
        print(f"📅 Expected intervals: {len(expected_intervals)}")
        print(f"📊 Actual intervals: {len(actual_timestamps)}")
        print(f"❌ Missing intervals: {len(missing_intervals)}")
        
        if missing_intervals:
            print("\n🚫 Missing intervals:")
            for missing in missing_intervals[:10]:  # Show first 10
                print(f"  - {missing.strftime('%H:%M')}")
            if len(missing_intervals) > 10:
                print(f"  ... and {len(missing_intervals) - 10} more")
    
    conn.close()

def compare_with_live_api():
    """Compare database values with current live API"""
    print("\n🔍 COMPARING WITH LIVE API")
    print("=" * 50)
    
    try:
        # Get current live data
        response = requests.get("http://localhost:8000/api/power-generation-intervals", timeout=10)
        if response.status_code == 200:
            api_data = response.json()
            current_interval = api_data[0] if api_data else None
            
            if current_interval:
                print("🌐 Current live API data:")
                print(f"  Time: {current_interval['timestamp']}")
                print(f"  Production: {current_interval['total_production']:.0f} MW")
                print(f"  Consumption: {current_interval['total_consumption']:.0f} MW")
                print(f"  Imports: {current_interval['imports']:.0f} MW")
                print(f"  Exports: {current_interval['exports']:.0f} MW")
                print(f"  Net Balance: {current_interval['net_balance']:.0f} MW")
                
                # Check if this matches database
                conn = get_database_connection()
                cursor = conn.cursor()
                
                # Extract timestamp for database query
                api_timestamp = current_interval['timestamp']
                cursor.execute("""
                    SELECT timestamp, total_production, total_consumption, imports, exports, net_balance 
                    FROM power_generation_data 
                    WHERE timestamp = ?
                """, (api_timestamp,))
                
                db_record = cursor.fetchone()
                
                if db_record:
                    print("\n💾 Corresponding database record:")
                    print(f"  Time: {db_record[0]}")
                    print(f"  Production: {db_record[1]:.0f} MW")
                    print(f"  Consumption: {db_record[2]:.0f} MW")
                    print(f"  Imports: {db_record[3]:.0f} MW")
                    print(f"  Exports: {db_record[4]:.0f} MW")
                    print(f"  Net Balance: {db_record[5]:.0f} MW")
                    
                    # Compare values
                    print("\n🔍 COMPARISON:")
                    fields = ['total_production', 'total_consumption', 'imports', 'exports', 'net_balance']
                    db_values = [db_record[1], db_record[2], db_record[3], db_record[4], db_record[5]]
                    api_values = [current_interval[field] for field in fields]
                    
                    matches = 0
                    for i, field in enumerate(fields):
                        api_val = api_values[i]
                        db_val = db_values[i]
                        match = abs(api_val - db_val) < 1  # Allow 1 MW tolerance
                        matches += match
                        status = "✅" if match else "❌"
                        print(f"  {field}: API={api_val:.0f}, DB={db_val:.0f} {status}")
                    
                    print(f"\n📊 Match rate: {matches}/{len(fields)} fields")
                else:
                    print("\n❌ No corresponding database record found!")
                
                conn.close()
        else:
            print(f"❌ Failed to get API data: {response.status_code}")
    
    except Exception as e:
        print(f"❌ Error comparing with API: {e}")

def examine_zero_value_pattern():
    """Examine the pattern of zero values in imports/exports"""
    print("\n🔍 EXAMINING ZERO VALUE PATTERNS")
    print("=" * 50)
    
    conn = get_database_connection()
    cursor = conn.cursor()
    
    today = datetime.now().strftime('%Y-%m-%d')
    
    # Get records with zero imports/exports
    cursor.execute("""
        SELECT timestamp, total_production, total_consumption, imports, exports 
        FROM power_generation_data 
        WHERE DATE(timestamp) = ? AND (imports = 0 OR exports = 0)
        ORDER BY timestamp
    """, (today,))
    
    zero_records = cursor.fetchall()
    
    print(f"📊 Records with zero imports or exports: {len(zero_records)}")
    
    if zero_records:
        print("\n📋 Zero value records:")
        print("Time     | Prod  | Cons  | Import| Export")
        print("-" * 40)
        
        for record in zero_records:
            timestamp, prod, cons, imports, exports = record
            time_part = timestamp.split()[1][:5]
            print(f"{time_part}    | {prod:5.0f} | {cons:5.0f} | {imports:6.0f}| {exports:6.0f}")
        
        # Analyze time pattern
        zero_times = [r[0].split()[1][:5] for r in zero_records]
        print(f"\n🕐 Time range of zero values: {min(zero_times)} to {max(zero_times)}")
    
    # Get records with non-zero imports/exports
    cursor.execute("""
        SELECT timestamp, total_production, total_consumption, imports, exports 
        FROM power_generation_data 
        WHERE DATE(timestamp) = ? AND imports > 0 AND exports > 0
        ORDER BY timestamp
        LIMIT 10
    """, (today,))
    
    nonzero_records = cursor.fetchall()
    
    if nonzero_records:
        print(f"\n📊 Sample non-zero records: {len(nonzero_records)}")
        print("Time     | Prod  | Cons  | Import| Export")
        print("-" * 40)
        
        for record in nonzero_records:
            timestamp, prod, cons, imports, exports = record
            time_part = timestamp.split()[1][:5]
            print(f"{time_part}    | {prod:5.0f} | {cons:5.0f} | {imports:6.0f}| {exports:6.0f}")
    
    conn.close()

def main():
    """Main investigation function"""
    print("🔍 INVESTIGATING DATABASE INCONSISTENCIES")
    print("=" * 60)
    print(f"📅 Investigation time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    try:
        examine_database_structure()
        examine_todays_data()
        compare_with_live_api()
        examine_zero_value_pattern()
        
        print("\n" + "=" * 60)
        print("✅ Investigation completed!")
        print("\n💡 KEY FINDINGS SUMMARY:")
        print("1. Check if database has missing intervals")
        print("2. Identify pattern of zero imports/exports")
        print("3. Compare current live data with database")
        print("4. Analyze time patterns of inconsistencies")
        
    except Exception as e:
        print(f"❌ Investigation failed: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
