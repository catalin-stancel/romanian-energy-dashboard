#!/usr/bin/env python3
"""
Script to check what was saved in the database for the 14:45 interval.
"""

import sys
import os
sys.path.append('src')

from data.models import PowerGenerationData, get_session
from datetime import datetime
import pytz

def check_14_45_record():
    """Check what was saved for the 14:45 interval."""
    print("🔍 Checking Database Record for 14:45 Interval")
    print("=" * 60)
    
    # Create the 14:45 timestamp in Romanian timezone
    romanian_tz = pytz.timezone('Europe/Bucharest')
    target_time = datetime(2025, 8, 19, 14, 45, 0)
    target_time = romanian_tz.localize(target_time)
    
    session = get_session()
    
    try:
        # Query for the 14:45 record
        record = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == target_time)\
            .first()
        
        if not record:
            print(f"❌ No record found for {target_time}")
            return False
        
        print(f"✅ Found record for {target_time}")
        print(f"📊 Database Record Details:")
        print(f"   ID: {record.id}")
        print(f"   Timestamp: {record.timestamp}")
        print(f"   Production: {record.total_production} MW")
        print(f"   Consumption: {record.total_consumption} MW")
        print(f"   Net Balance: {record.net_balance} MW")
        print(f"   Imports: {record.imports} MW")
        print(f"   Exports: {record.exports} MW")
        
        print(f"\n🌐 Individual Border Point Values:")
        print(f"   MUKA: {record.unit_muka}")
        print(f"   ISPOZ: {record.unit_ispoz}")
        print(f"   IS: {record.unit_is}")
        print(f"   UNGE: {record.unit_unge}")
        print(f"   CIOA: {record.unit_cioa}")
        print(f"   GOTE: {record.unit_gote}")
        print(f"   VULC: {record.unit_vulc}")
        print(f"   DOBR: {record.unit_dobr}")
        print(f"   VARN: {record.unit_varn}")
        print(f"   KOZL1: {record.unit_kozl1}")
        print(f"   KOZL2: {record.unit_kozl2}")
        print(f"   DJER: {record.unit_djer}")
        print(f"   SIP_: {record.unit_sip}")
        print(f"   PANCEVO21: {record.unit_pancevo21}")
        print(f"   PANCEVO22: {record.unit_pancevo22}")
        print(f"   KIKI: {record.unit_kiki}")
        print(f"   SAND: {record.unit_sand}")
        print(f"   BEKE1: {record.unit_beke1}")
        print(f"   BEKE115: {record.unit_beke115}")
        
        # Calculate imports and exports from individual values
        border_values = [
            record.unit_muka or 0,
            record.unit_ispoz or 0,
            record.unit_is or 0,
            record.unit_unge or 0,
            record.unit_cioa or 0,
            record.unit_gote or 0,
            record.unit_vulc or 0,
            record.unit_dobr or 0,
            record.unit_varn or 0,
            record.unit_kozl1 or 0,
            record.unit_kozl2 or 0,
            record.unit_djer or 0,
            record.unit_sip or 0,
            record.unit_pancevo21 or 0,
            record.unit_pancevo22 or 0,
            record.unit_kiki or 0,
            record.unit_sand or 0,
            record.unit_beke1 or 0,
        ]
        
        # Calculate using 18 border points (excluding BEKE115)
        calculated_imports_18 = sum(v for v in border_values if v > 0)
        calculated_exports_18 = sum(-v for v in border_values if v < 0)
        
        # Calculate using 19 border points (including BEKE115)
        border_values_19 = border_values + [record.unit_beke115 or 0]
        calculated_imports_19 = sum(v for v in border_values_19 if v > 0)
        calculated_exports_19 = sum(-v for v in border_values_19 if v < 0)
        
        print(f"\n🧮 Calculated Values:")
        print(f"   Using 18 border points (excluding BEKE115):")
        print(f"     Calculated Imports: {calculated_imports_18} MW")
        print(f"     Calculated Exports: {calculated_exports_18} MW")
        print(f"   Using 19 border points (including BEKE115):")
        print(f"     Calculated Imports: {calculated_imports_19} MW")
        print(f"     Calculated Exports: {calculated_exports_19} MW")
        
        print(f"\n📋 Stored vs Calculated Comparison:")
        print(f"   Stored Imports: {record.imports} MW")
        print(f"   Stored Exports: {record.exports} MW")
        
        if record.imports == calculated_imports_18:
            print(f"   ✅ Stored imports match 18-point calculation")
        elif record.imports == calculated_imports_19:
            print(f"   ✅ Stored imports match 19-point calculation")
        else:
            print(f"   ❌ Stored imports don't match either calculation")
        
        if record.exports == calculated_exports_18:
            print(f"   ✅ Stored exports match 18-point calculation")
        elif record.exports == calculated_exports_19:
            print(f"   ✅ Stored exports match 19-point calculation")
        else:
            print(f"   ❌ Stored exports don't match either calculation")
        
        # Check if raw data is available
        if record.raw_data:
            print(f"\n📄 Raw Data Available: Yes ({len(record.raw_data)} characters)")
        else:
            print(f"\n📄 Raw Data Available: No")
        
        return True
        
    except Exception as e:
        print(f"❌ Error querying database: {e}")
        return False
    finally:
        session.close()

if __name__ == "__main__":
    check_14_45_record()
