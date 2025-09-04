#!/usr/bin/env python3
"""
Debug script to understand why dashboard shows different values than database.
"""

import sqlite3
import sys
import os

# Add src to path to import modules
sys.path.append(os.path.join(os.path.dirname(__file__), 'src'))

from data.interval_transition_collector import IntervalTransitionCollector

def check_database_directly():
    """Check database values directly."""
    print("🔍 Checking database values directly...\n")
    
    conn = sqlite3.connect('data/balancing_market.db')
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT timestamp, total_production, total_consumption, imports, exports, net_balance
        FROM power_generation_data
        ORDER BY timestamp DESC
        LIMIT 5
    """)
    
    records = cursor.fetchall()
    print("📊 Database Records:")
    for record in records:
        print(f"   {record[0]} - Prod: {record[1]}, Cons: {record[2]}, Imp: {record[3]}, Exp: {record[4]}, Net: {record[5]}")
    
    conn.close()
    return records

def check_collector_logic():
    """Check what the collector returns."""
    print("\n🔍 Checking collector logic...\n")
    
    try:
        collector = IntervalTransitionCollector()
        latest_data = collector.get_latest_data()
        
        if latest_data:
            print("📊 Collector Returns:")
            print(f"   Timestamp: {latest_data['timestamp']}")
            print(f"   Production: {latest_data['totals']['production']} MW")
            print(f"   Consumption: {latest_data['totals']['consumption']} MW")
            print(f"   Imports: {latest_data['totals']['imports']} MW")
            print(f"   Exports: {latest_data['totals']['exports']} MW")
            print(f"   Net Balance: {latest_data['totals']['net_balance']} MW")
            
            return latest_data
        else:
            print("❌ Collector returned no data")
            return None
            
    except Exception as e:
        print(f"❌ Error with collector: {e}")
        return None

def simulate_dashboard_api():
    """Simulate what the dashboard API would return."""
    print("\n🔍 Simulating dashboard API logic...\n")
    
    try:
        collector = IntervalTransitionCollector()
        latest_data = collector.get_latest_data()
        
        if not latest_data:
            print("❌ No data available for dashboard")
            return
        
        # This simulates the dashboard API logic
        intervals = []
        
        # Get recent intervals from database
        conn = sqlite3.connect('data/balancing_market.db')
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT timestamp, total_production, total_consumption, imports, exports, net_balance
            FROM power_generation_data
            ORDER BY timestamp DESC
            LIMIT 10
        """)
        
        records = cursor.fetchall()
        
        for record in records:
            interval_data = {
                'timestamp': record[0],
                'production': record[1],
                'consumption': record[2],
                'imports': record[3] if record[3] is not None else 0,
                'exports': record[4] if record[4] is not None else 0,
                'net_balance': record[5]
            }
            intervals.append(interval_data)
        
        conn.close()
        
        print("📊 Simulated Dashboard API Response:")
        for interval in intervals:
            print(f"   {interval['timestamp']} - Prod: {interval['production']}, Cons: {interval['consumption']}, Imp: {interval['imports']}, Exp: {interval['exports']}")
        
        return intervals
        
    except Exception as e:
        print(f"❌ Error simulating dashboard API: {e}")
        return None

def check_live_api_data():
    """Check what live API returns."""
    print("\n🔍 Checking live API data...\n")
    
    try:
        from api.transelectrica_client import TranselectricaClient
        
        client = TranselectricaClient()
        power_data = client.fetch_power_data()
        
        if power_data:
            print("📊 Live API Data:")
            print(f"   Production: {power_data['totals']['production']} MW")
            print(f"   Consumption: {power_data['totals']['consumption']} MW")
            print(f"   Imports: {power_data['totals']['imports']} MW")
            print(f"   Exports: {power_data['totals']['exports']} MW")
            print(f"   Net Balance: {power_data['totals']['net_balance']} MW")
            
            return power_data
        else:
            print("❌ No live API data available")
            return None
            
    except Exception as e:
        print(f"❌ Error fetching live API data: {e}")
        return None

def main():
    print("🔍 Dashboard Discrepancy Analysis")
    print("=" * 80)
    
    # Check database directly
    db_records = check_database_directly()
    
    # Check collector logic
    collector_data = check_collector_logic()
    
    # Simulate dashboard API
    dashboard_data = simulate_dashboard_api()
    
    # Check live API
    live_data = check_live_api_data()
    
    print("\n" + "=" * 80)
    print("🧮 Analysis Summary:")
    
    if db_records and len(db_records) >= 2:
        latest_db = db_records[0]
        print(f"\n📊 Latest Database Record ({latest_db[0]}):")
        print(f"   Imports: {latest_db[3]}, Exports: {latest_db[4]}")
        
        if collector_data:
            print(f"\n🔄 Collector Returns:")
            print(f"   Imports: {collector_data['totals']['imports']}, Exports: {collector_data['totals']['exports']}")
            
            if latest_db[3] != collector_data['totals']['imports']:
                print(f"   ⚠️  MISMATCH: DB imports ({latest_db[3]}) != Collector imports ({collector_data['totals']['imports']})")
    
    print(f"\n🎯 The discrepancy you're seeing is likely due to:")
    print(f"   1. Dashboard showing live API data instead of database data")
    print(f"   2. Different calculation logic between storage and display")
    print(f"   3. Caching issues in the web application")
    print(f"   4. Real-time updates overriding stored historical data")

if __name__ == "__main__":
    main()
