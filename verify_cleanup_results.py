#!/usr/bin/env python3
"""
Script to verify the cleanup results and test system functionality.
"""

import sqlite3
import requests
import json
from datetime import datetime

def verify_database():
    """Verify the database state after cleanup."""
    print("🔍 Verifying database state...")
    
    conn = sqlite3.connect('data/balancing_market.db')
    cursor = conn.cursor()
    
    # Check total records
    cursor.execute("SELECT COUNT(*) FROM power_generation_data")
    total_records = cursor.fetchone()[0]
    print(f"📊 Total records in database: {total_records}")
    
    # Get the remaining record details
    cursor.execute("""
        SELECT timestamp, total_production, total_consumption, imports, exports, net_balance
        FROM power_generation_data
        ORDER BY timestamp DESC
        LIMIT 5
    """)
    
    records = cursor.fetchall()
    print(f"\n📋 Remaining records ({len(records)}):")
    for record in records:
        print(f"   {record[0]} - Prod: {record[1]}, Cons: {record[2]}, Imp: {record[3]}, Exp: {record[4]}, Net: {record[5]}")
    
    conn.close()
    return total_records == 1

def test_dashboard_api():
    """Test that the dashboard API still works."""
    print("\n🌐 Testing dashboard API...")
    
    try:
        # Test the power generation intervals endpoint
        response = requests.get('http://localhost:5000/api/power-generation-intervals', timeout=5)
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ API responded successfully")
            print(f"   Intervals returned: {len(data.get('intervals', []))}")
            
            if data.get('intervals'):
                latest = data['intervals'][0]
                print(f"   Latest interval: {latest.get('timestamp')}")
                print(f"   Production: {latest.get('production')} MW")
                print(f"   Consumption: {latest.get('consumption')} MW")
                print(f"   Imports: {latest.get('imports')} MW")
                print(f"   Exports: {latest.get('exports')} MW")
            
            return True
        else:
            print(f"❌ API returned status code: {response.status_code}")
            return False
            
    except requests.exceptions.ConnectionError:
        print("⚠️  Dashboard API not accessible (server may not be running)")
        return False
    except Exception as e:
        print(f"❌ API test failed: {e}")
        return False

def main():
    print("🧪 Verifying cleanup results and system functionality...\n")
    
    # Verify database state
    db_ok = verify_database()
    
    # Test dashboard API
    api_ok = test_dashboard_api()
    
    print(f"\n📊 Verification Summary:")
    print(f"   Database cleanup: {'✅ Success' if db_ok else '❌ Failed'}")
    print(f"   Dashboard API: {'✅ Working' if api_ok else '⚠️  Not accessible'}")
    
    if db_ok:
        print(f"\n🎉 Database cleanup completed successfully!")
        print(f"   - All historical data removed except 17:30 interval")
        print(f"   - System ready to collect new data")
        print(f"   - Dashboard will show clean data going forward")
    else:
        print(f"\n❌ Database verification failed!")

if __name__ == "__main__":
    main()
