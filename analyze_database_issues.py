#!/usr/bin/env python3
"""
Detailed analysis of database issues in Power generation Data table.
This script will identify duplicates, missing intervals, and inconsistencies.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.models import PowerGenerationData, get_session
from datetime import datetime, timedelta
import pytz
from collections import defaultdict

def analyze_database_issues():
    """Analyze database issues in detail."""
    print("🔍 DETAILED DATABASE ANALYSIS")
    print("=" * 80)
    
    # Romanian timezone
    romanian_tz = pytz.timezone('Europe/Bucharest')
    current_time = datetime.now(romanian_tz)
    
    session = get_session()
    try:
        # Check today's data
        today = current_time.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
        tomorrow = today + timedelta(days=1)
        
        print(f"📅 Analyzing data for: {today.date()}")
        
        # Get all today's records
        today_records = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp >= today)\
            .filter(PowerGenerationData.timestamp < tomorrow)\
            .order_by(PowerGenerationData.timestamp)\
            .all()
        
        print(f"📊 Total records found: {len(today_records)}")
        
        # 1. Check for duplicates
        print("\n1️⃣ CHECKING FOR DUPLICATE INTERVALS")
        print("-" * 50)
        
        timestamp_counts = defaultdict(list)
        for record in today_records:
            timestamp_counts[record.timestamp].append(record)
        
        duplicates_found = False
        for timestamp, records in timestamp_counts.items():
            if len(records) > 1:
                duplicates_found = True
                interval_num = get_interval_number_from_timestamp(timestamp)
                print(f"   ⚠️ DUPLICATE: Interval {interval_num} ({timestamp.strftime('%H:%M')}) - {len(records)} records")
                
                for i, record in enumerate(records):
                    print(f"     Record {i+1}: ID={record.id}, Prod={record.total_production} MW, "
                          f"Cons={record.total_consumption} MW, Imports={record.imports} MW, Exports={record.exports} MW")
        
        if not duplicates_found:
            print("   ✅ No duplicates found")
        
        # 2. Check for missing intervals
        print("\n2️⃣ CHECKING FOR MISSING INTERVALS")
        print("-" * 50)
        
        expected_intervals = set()
        for i in range(96):
            interval_time = today + timedelta(minutes=i * 15)
            expected_intervals.add(interval_time)
        
        actual_intervals = set(record.timestamp for record in today_records)
        missing_intervals = expected_intervals - actual_intervals
        
        if missing_intervals:
            print(f"   ⚠️ MISSING INTERVALS: {len(missing_intervals)} intervals missing")
            for missing_time in sorted(missing_intervals):
                interval_num = get_interval_number_from_timestamp(missing_time)
                print(f"     Missing: Interval {interval_num} ({missing_time.strftime('%H:%M')})")
        else:
            print("   ✅ No missing intervals")
        
        # 3. Check for calculation inconsistencies
        print("\n3️⃣ CHECKING CALCULATION INCONSISTENCIES")
        print("-" * 50)
        
        inconsistencies_found = False
        for record in today_records:
            # Check net balance calculation
            calculated_net = record.total_production - record.total_consumption
            stored_net = record.net_balance
            net_diff = abs(calculated_net - stored_net)
            
            if net_diff > 0.1:  # Allow small floating point differences
                inconsistencies_found = True
                interval_num = get_interval_number_from_timestamp(record.timestamp)
                print(f"   ⚠️ NET BALANCE MISMATCH: Interval {interval_num} ({record.timestamp.strftime('%H:%M')})")
                print(f"     Calculated: {calculated_net:.1f} MW, Stored: {stored_net:.1f} MW, Diff: {net_diff:.1f} MW")
            
            # Check import/export calculations from border points
            border_values = [
                record.unit_muka or 0, record.unit_ispoz or 0, record.unit_is or 0,
                record.unit_unge or 0, record.unit_cioa or 0, record.unit_gote or 0,
                record.unit_vulc or 0, record.unit_dobr or 0, record.unit_varn or 0,
                record.unit_kozl1 or 0, record.unit_kozl2 or 0, record.unit_djer or 0,
                record.unit_sip or 0, record.unit_pancevo21 or 0, record.unit_pancevo22 or 0,
                record.unit_kiki or 0, record.unit_sand or 0, record.unit_beke1 or 0,
                record.unit_beke115 or 0
            ]
            
            calc_imports = sum(v for v in border_values if v > 0)
            calc_exports = sum(-v for v in border_values if v < 0)
            
            stored_imports = record.imports or 0
            stored_exports = record.exports or 0
            
            imports_diff = abs(calc_imports - stored_imports)
            exports_diff = abs(calc_exports - stored_exports)
            
            if imports_diff > 0.1 or exports_diff > 0.1:
                inconsistencies_found = True
                interval_num = get_interval_number_from_timestamp(record.timestamp)
                print(f"   ⚠️ IMPORT/EXPORT MISMATCH: Interval {interval_num} ({record.timestamp.strftime('%H:%M')})")
                print(f"     Imports - Calculated: {calc_imports:.1f} MW, Stored: {stored_imports:.1f} MW, Diff: {imports_diff:.1f} MW")
                print(f"     Exports - Calculated: {calc_exports:.1f} MW, Stored: {stored_exports:.1f} MW, Diff: {exports_diff:.1f} MW")
        
        if not inconsistencies_found:
            print("   ✅ No calculation inconsistencies found")
        
        # 4. Check data collection gaps
        print("\n4️⃣ CHECKING DATA COLLECTION GAPS")
        print("-" * 50)
        
        if len(today_records) > 1:
            gaps_found = False
            for i in range(1, len(today_records)):
                prev_record = today_records[i-1]
                curr_record = today_records[i]
                
                expected_next_time = prev_record.timestamp + timedelta(minutes=15)
                actual_time = curr_record.timestamp
                
                if actual_time != expected_next_time:
                    gaps_found = True
                    gap_minutes = (actual_time - expected_next_time).total_seconds() / 60
                    print(f"   ⚠️ GAP DETECTED: Between {prev_record.timestamp.strftime('%H:%M')} and {actual_time.strftime('%H:%M')}")
                    print(f"     Gap duration: {gap_minutes:.0f} minutes")
            
            if not gaps_found:
                print("   ✅ No collection gaps found")
        else:
            print("   ⚠️ Insufficient data to check for gaps")
        
        # 5. Show recent intervals with details
        print("\n5️⃣ RECENT INTERVALS DETAILED VIEW")
        print("-" * 50)
        
        recent_records = today_records[-5:] if today_records else []
        for record in recent_records:
            interval_num = get_interval_number_from_timestamp(record.timestamp)
            print(f"   Interval {interval_num:2d} ({record.timestamp.strftime('%H:%M')}):")
            print(f"     ID: {record.id}")
            print(f"     Production: {record.total_production} MW")
            print(f"     Consumption: {record.total_consumption} MW")
            print(f"     Net Balance: {record.net_balance} MW")
            print(f"     Imports: {record.imports} MW")
            print(f"     Exports: {record.exports} MW")
            print(f"     Created: {record.created_at}")
            print(f"     Updated: {record.updated_at}")
            print()
        
        # 6. Check for specific problematic patterns
        print("\n6️⃣ CHECKING FOR PROBLEMATIC PATTERNS")
        print("-" * 50)
        
        # Check for records with identical values (possible stale data)
        value_groups = defaultdict(list)
        for record in today_records:
            key = (record.total_production, record.total_consumption, record.imports, record.exports)
            value_groups[key].append(record)
        
        identical_found = False
        for values, records in value_groups.items():
            if len(records) > 3:  # More than 3 intervals with identical values is suspicious
                identical_found = True
                print(f"   ⚠️ IDENTICAL VALUES: {len(records)} intervals with same values")
                print(f"     Values: Prod={values[0]} MW, Cons={values[1]} MW, Imp={values[2]} MW, Exp={values[3]} MW")
                print(f"     Intervals: {[get_interval_number_from_timestamp(r.timestamp) for r in records[:5]]}")
        
        if not identical_found:
            print("   ✅ No suspicious identical value patterns found")
    
    finally:
        session.close()
    
    print("\n" + "=" * 80)
    print("🎯 DATABASE ANALYSIS COMPLETE")
    print("=" * 80)

def get_interval_number_from_timestamp(timestamp):
    """Get interval number from timestamp."""
    start_of_day = timestamp.replace(hour=0, minute=0, second=0, microsecond=0)
    minutes_since_start = (timestamp - start_of_day).total_seconds() / 60
    interval_number = int(minutes_since_start // 15) + 1
    return min(interval_number, 96)

if __name__ == "__main__":
    analyze_database_issues()
