#!/usr/bin/env python3
"""
Comprehensive fix for interval inconsistencies in Power generation Data table.
This script will:
1. Remove duplicate intervals (keeping the most recent)
2. Fix net balance sign errors
3. Recalculate import/export values from border points
4. Fill missing intervals where possible
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.models import PowerGenerationData, get_session
from datetime import datetime, timedelta
import pytz
from collections import defaultdict

def fix_interval_inconsistencies():
    """Fix all identified interval inconsistencies."""
    print("🔧 FIXING INTERVAL INCONSISTENCIES")
    print("=" * 80)
    
    # Romanian timezone
    romanian_tz = pytz.timezone('Europe/Bucharest')
    current_time = datetime.now(romanian_tz)
    
    session = get_session()
    try:
        # Check today's data
        today = current_time.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
        tomorrow = today + timedelta(days=1)
        
        print(f"📅 Fixing data for: {today.date()}")
        
        # Get all today's records
        today_records = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp >= today)\
            .filter(PowerGenerationData.timestamp < tomorrow)\
            .order_by(PowerGenerationData.timestamp, PowerGenerationData.id)\
            .all()
        
        print(f"📊 Total records found: {len(today_records)}")
        
        # 1. Fix duplicates - keep the most recent record for each timestamp
        print("\n1️⃣ FIXING DUPLICATE INTERVALS")
        print("-" * 50)
        
        timestamp_groups = defaultdict(list)
        for record in today_records:
            timestamp_groups[record.timestamp].append(record)
        
        duplicates_removed = 0
        for timestamp, records in timestamp_groups.items():
            if len(records) > 1:
                # Sort by ID (most recent has higher ID) and keep the last one
                records.sort(key=lambda x: x.id)
                records_to_delete = records[:-1]  # All except the last one
                
                interval_num = get_interval_number_from_timestamp(timestamp)
                print(f"   🗑️ Removing {len(records_to_delete)} duplicate(s) for Interval {interval_num} ({timestamp.strftime('%H:%M')})")
                
                for record in records_to_delete:
                    print(f"     Deleting ID {record.id}: Prod={record.total_production} MW, Cons={record.total_consumption} MW")
                    session.delete(record)
                    duplicates_removed += 1
        
        if duplicates_removed > 0:
            session.commit()
            print(f"   ✅ Removed {duplicates_removed} duplicate records")
        else:
            print("   ✅ No duplicates to remove")
        
        # 2. Refresh the records list after removing duplicates
        today_records = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp >= today)\
            .filter(PowerGenerationData.timestamp < tomorrow)\
            .order_by(PowerGenerationData.timestamp)\
            .all()
        
        # 3. Fix calculation inconsistencies
        print("\n2️⃣ FIXING CALCULATION INCONSISTENCIES")
        print("-" * 50)
        
        records_fixed = 0
        for record in today_records:
            needs_update = False
            
            # Fix net balance calculation
            calculated_net = record.total_production - record.total_consumption
            stored_net = record.net_balance
            
            # Check if net balance is wrong (sign error or calculation error)
            if abs(calculated_net - stored_net) > 0.1:
                print(f"   🔧 Fixing net balance for Interval {get_interval_number_from_timestamp(record.timestamp)} ({record.timestamp.strftime('%H:%M')})")
                print(f"     Old: {stored_net} MW → New: {calculated_net} MW")
                record.net_balance = calculated_net
                needs_update = True
            
            # Recalculate import/export values from border points
            border_values = [
                record.unit_muka or 0, record.unit_ispoz or 0, record.unit_is or 0,
                record.unit_unge or 0, record.unit_cioa or 0, record.unit_gote or 0,
                record.unit_vulc or 0, record.unit_dobr or 0, record.unit_varn or 0,
                record.unit_kozl1 or 0, record.unit_kozl2 or 0, record.unit_djer or 0,
                record.unit_sip or 0, record.unit_pancevo21 or 0, record.unit_pancevo22 or 0,
                record.unit_kiki or 0, record.unit_sand or 0, record.unit_beke1 or 0,
                record.unit_beke115 or 0
            ]
            
            # Calculate correct imports and exports
            calc_imports = sum(v for v in border_values if v > 0)
            calc_exports = sum(-v for v in border_values if v < 0)
            
            stored_imports = record.imports or 0
            stored_exports = record.exports or 0
            
            # Check if import/export values need fixing
            imports_diff = abs(calc_imports - stored_imports)
            exports_diff = abs(calc_exports - stored_exports)
            
            if imports_diff > 0.1 or exports_diff > 0.1:
                print(f"   🔧 Fixing imports/exports for Interval {get_interval_number_from_timestamp(record.timestamp)} ({record.timestamp.strftime('%H:%M')})")
                print(f"     Imports: {stored_imports} MW → {calc_imports} MW")
                print(f"     Exports: {stored_exports} MW → {calc_exports} MW")
                record.imports = calc_imports
                record.exports = calc_exports
                needs_update = True
            
            # Update total_import_export_units
            total_import_export = sum(border_values)
            if abs((record.total_import_export_units or 0) - total_import_export) > 0.1:
                record.total_import_export_units = total_import_export
                needs_update = True
            
            if needs_update:
                record.updated_at = datetime.utcnow()
                records_fixed += 1
        
        if records_fixed > 0:
            session.commit()
            print(f"   ✅ Fixed calculations for {records_fixed} records")
        else:
            print("   ✅ No calculation fixes needed")
        
        # 4. Report on missing intervals (we can't easily fill them without API data)
        print("\n3️⃣ CHECKING MISSING INTERVALS")
        print("-" * 50)
        
        expected_intervals = set()
        for i in range(96):
            interval_time = today + timedelta(minutes=i * 15)
            expected_intervals.add(interval_time)
        
        actual_intervals = set(record.timestamp for record in today_records)
        missing_intervals = expected_intervals - actual_intervals
        
        if missing_intervals:
            print(f"   ⚠️ {len(missing_intervals)} intervals still missing (cannot auto-fill without API data)")
            critical_missing = []
            for missing_time in sorted(missing_intervals):
                interval_num = get_interval_number_from_timestamp(missing_time)
                if interval_num <= 68:  # Only show missing intervals up to current time
                    critical_missing.append(f"Interval {interval_num} ({missing_time.strftime('%H:%M')})")
            
            if critical_missing:
                print(f"   📋 Critical missing intervals: {', '.join(critical_missing[:5])}")
                if len(critical_missing) > 5:
                    print(f"   📋 ... and {len(critical_missing) - 5} more")
        else:
            print("   ✅ No missing intervals")
        
        # 5. Final verification
        print("\n4️⃣ FINAL VERIFICATION")
        print("-" * 50)
        
        # Re-query to get updated records
        final_records = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp >= today)\
            .filter(PowerGenerationData.timestamp < tomorrow)\
            .order_by(PowerGenerationData.timestamp)\
            .all()
        
        # Check for remaining issues
        remaining_issues = 0
        for record in final_records:
            # Check net balance
            calculated_net = record.total_production - record.total_consumption
            if abs(calculated_net - record.net_balance) > 0.1:
                remaining_issues += 1
            
            # Check imports/exports
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
            
            if abs(calc_imports - (record.imports or 0)) > 0.1 or abs(calc_exports - (record.exports or 0)) > 0.1:
                remaining_issues += 1
        
        if remaining_issues == 0:
            print("   ✅ All calculation inconsistencies fixed!")
        else:
            print(f"   ⚠️ {remaining_issues} records still have calculation issues")
        
        # Check for remaining duplicates
        timestamp_counts = defaultdict(int)
        for record in final_records:
            timestamp_counts[record.timestamp] += 1
        
        remaining_duplicates = sum(1 for count in timestamp_counts.values() if count > 1)
        if remaining_duplicates == 0:
            print("   ✅ All duplicates removed!")
        else:
            print(f"   ⚠️ {remaining_duplicates} duplicate timestamps still exist")
        
        print(f"\n📊 Final record count: {len(final_records)}")
        
    except Exception as e:
        print(f"❌ Error during fix: {e}")
        session.rollback()
        raise
    finally:
        session.close()
    
    print("\n" + "=" * 80)
    print("🎯 INTERVAL INCONSISTENCIES FIX COMPLETE")
    print("=" * 80)

def get_interval_number_from_timestamp(timestamp):
    """Get interval number from timestamp."""
    start_of_day = timestamp.replace(hour=0, minute=0, second=0, microsecond=0)
    minutes_since_start = (timestamp - start_of_day).total_seconds() / 60
    interval_number = int(minutes_since_start // 15) + 1
    return min(interval_number, 96)

if __name__ == "__main__":
    fix_interval_inconsistencies()
