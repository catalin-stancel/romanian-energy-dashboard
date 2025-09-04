#!/usr/bin/env python3
"""
Script to verify that dashboard API data matches database data.
Compares the /api/power-generation-intervals endpoint with direct database queries.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

import requests
import json
from datetime import datetime, timedelta
from src.data.models import get_session, PowerGenerationData
from sqlalchemy import and_

def get_dashboard_api_data():
    """Get data from the dashboard API endpoint."""
    try:
        response = requests.get('http://localhost:8000/api/power-generation-intervals')
        if response.status_code == 200:
            return response.json()
        else:
            print(f"❌ API request failed with status {response.status_code}")
            return None
    except Exception as e:
        print(f"❌ Error fetching API data: {e}")
        return None

def get_database_data():
    """Get data directly from the database."""
    try:
        with get_session() as session:
            # Get today's data
            today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            tomorrow = today + timedelta(days=1)
            
            # Query all power generation data for today
            records = session.query(PowerGenerationData).filter(
                and_(
                    PowerGenerationData.timestamp >= today,
                    PowerGenerationData.timestamp < tomorrow
                )
            ).order_by(PowerGenerationData.timestamp).all()
            
            # Convert to dictionary format similar to API
            db_data = {}
            for record in records:
                timestamp_key = record.timestamp.replace(second=0, microsecond=0)
                db_data[timestamp_key] = {
                    'timestamp': record.timestamp,
                    'production': record.total_production,
                    'consumption': record.total_consumption,
                    'imports': getattr(record, 'imports', 0.0) or 0.0,
                    'exports': getattr(record, 'exports', 0.0) or 0.0,
                    'net_balance': record.net_balance
                }
            
            return db_data
            
    except Exception as e:
        print(f"❌ Error fetching database data: {e}")
        return None

def compare_data(api_data, db_data):
    """Compare API data with database data."""
    print("🔍 DASHBOARD vs DATABASE COMPARISON")
    print("=" * 60)
    
    if not api_data or not db_data:
        print("❌ Missing data - cannot compare")
        return
    
    api_intervals = api_data.get('intervals', [])
    print(f"📊 API returned {len(api_intervals)} intervals")
    print(f"💾 Database has {len(db_data)} records")
    
    # Check intervals that have data in both sources
    matches = 0
    mismatches = 0
    api_only = 0
    db_only = 0
    
    print("\n🔍 DETAILED COMPARISON:")
    print("-" * 60)
    
    # Create a set of all timestamps from both sources
    api_timestamps = set()
    for interval in api_intervals:
        if interval.get('has_data'):
            timestamp_str = interval['timestamp']
            timestamp = datetime.fromisoformat(timestamp_str.replace('Z', ''))
            api_timestamps.add(timestamp)
    
    db_timestamps = set(db_data.keys())
    
    # Find common timestamps
    common_timestamps = api_timestamps.intersection(db_timestamps)
    api_only_timestamps = api_timestamps - db_timestamps
    db_only_timestamps = db_timestamps - api_timestamps
    
    print(f"📈 Common timestamps: {len(common_timestamps)}")
    print(f"🌐 API only: {len(api_only_timestamps)}")
    print(f"💾 DB only: {len(db_only_timestamps)}")
    
    if api_only_timestamps:
        print(f"\n🌐 API-only timestamps:")
        for ts in sorted(api_only_timestamps):
            print(f"   {ts.strftime('%H:%M')}")
    
    if db_only_timestamps:
        print(f"\n💾 DB-only timestamps:")
        for ts in sorted(db_only_timestamps):
            print(f"   {ts.strftime('%H:%M')}")
    
    # Compare common timestamps
    if common_timestamps:
        print(f"\n📊 COMPARING {len(common_timestamps)} COMMON INTERVALS:")
        print("-" * 60)
        
        for timestamp in sorted(common_timestamps):
            # Find API interval for this timestamp
            api_interval = None
            for interval in api_intervals:
                interval_ts = datetime.fromisoformat(interval['timestamp'].replace('Z', ''))
                if interval_ts == timestamp:
                    api_interval = interval
                    break
            
            db_record = db_data[timestamp]
            
            if api_interval:
                # Compare values
                api_prod = api_interval.get('production')
                api_cons = api_interval.get('consumption')
                api_imports = api_interval.get('imports', 0.0)
                api_exports = api_interval.get('exports', 0.0)
                api_net = api_interval.get('net_balance')
                
                db_prod = db_record['production']
                db_cons = db_record['consumption']
                db_imports = db_record['imports']
                db_exports = db_record['exports']
                db_net = db_record['net_balance']
                
                # Check for matches (allow small floating point differences)
                prod_match = abs((api_prod or 0) - (db_prod or 0)) < 0.1
                cons_match = abs((api_cons or 0) - (db_cons or 0)) < 0.1
                imports_match = abs((api_imports or 0) - (db_imports or 0)) < 0.1
                exports_match = abs((api_exports or 0) - (db_exports or 0)) < 0.1
                net_match = abs((api_net or 0) - (db_net or 0)) < 0.1
                
                all_match = prod_match and cons_match and imports_match and exports_match and net_match
                
                if all_match:
                    matches += 1
                    print(f"✅ {timestamp.strftime('%H:%M')} - MATCH")
                else:
                    mismatches += 1
                    print(f"❌ {timestamp.strftime('%H:%M')} - MISMATCH:")
                    if not prod_match:
                        print(f"   Production: API={api_prod}, DB={db_prod}")
                    if not cons_match:
                        print(f"   Consumption: API={api_cons}, DB={db_cons}")
                    if not imports_match:
                        print(f"   Imports: API={api_imports}, DB={db_imports}")
                    if not exports_match:
                        print(f"   Exports: API={api_exports}, DB={db_exports}")
                    if not net_match:
                        print(f"   Net Balance: API={api_net}, DB={db_net}")
    
    # Summary
    print("\n📋 SUMMARY:")
    print("=" * 60)
    print(f"✅ Matches: {matches}")
    print(f"❌ Mismatches: {mismatches}")
    print(f"🌐 API only: {len(api_only_timestamps)}")
    print(f"💾 DB only: {len(db_only_timestamps)}")
    
    if matches > 0 and mismatches == 0 and len(api_only_timestamps) == 0:
        print("\n🎉 PERFECT MATCH! Dashboard data matches database data exactly.")
    elif mismatches == 0:
        print("\n✅ DATA CONSISTENCY: All common data matches perfectly.")
        if len(api_only_timestamps) > 0:
            print("   Note: API has some additional current/live data not yet in DB.")
    else:
        print("\n⚠️ DATA INCONSISTENCY DETECTED: Some values don't match between API and DB.")
    
    return {
        'matches': matches,
        'mismatches': mismatches,
        'api_only': len(api_only_timestamps),
        'db_only': len(db_only_timestamps),
        'total_common': len(common_timestamps)
    }

def main():
    """Main verification function."""
    print("🔍 VERIFYING DASHBOARD vs DATABASE DATA CONSISTENCY")
    print("=" * 60)
    print("📡 Fetching data from dashboard API...")
    
    # Get API data
    api_data = get_dashboard_api_data()
    if not api_data:
        print("❌ Failed to get API data")
        return
    
    print("💾 Fetching data from database...")
    
    # Get database data
    db_data = get_database_data()
    if not db_data:
        print("❌ Failed to get database data")
        return
    
    # Compare the data
    results = compare_data(api_data, db_data)
    
    # Show current interval info from API
    current_interval = api_data.get('current_interval')
    if current_interval:
        print(f"\n🕐 Current interval: {current_interval}")
        
        # Find current interval data
        for interval in api_data.get('intervals', []):
            if interval.get('is_current'):
                print(f"   Time: {interval.get('time')}")
                print(f"   Production: {interval.get('production')} MW")
                print(f"   Consumption: {interval.get('consumption')} MW")
                print(f"   Imports: {interval.get('imports')} MW")
                print(f"   Exports: {interval.get('exports')} MW")
                print(f"   Net Balance: {interval.get('net_balance')} MW")
                print(f"   Status: {interval.get('status')}")
                break

if __name__ == "__main__":
    main()
