#!/usr/bin/env python3
"""
Script to fix historical imports/exports values in the database using the corrected calculation.
"""

import sys
import os
sys.path.append('src')

from data.models import PowerGenerationData, get_session
from api.transelectrica_client import TranselectricaClient
import json
from datetime import datetime, timedelta

def fix_historical_imports_exports():
    """Fix historical imports/exports values using the corrected calculation."""
    print("🔧 Fixing Historical Imports/Exports Values")
    print("=" * 60)
    
    client = TranselectricaClient()
    session = get_session()
    
    try:
        # Get all records that have raw_data (so we can recalculate)
        records = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.raw_data.isnot(None))\
            .order_by(PowerGenerationData.timestamp.desc())\
            .all()
        
        print(f"📊 Found {len(records)} records with raw data to process")
        
        updated_count = 0
        error_count = 0
        
        for record in records:
            try:
                # Parse the raw JSON data
                raw_data = json.loads(record.raw_data)
                
                # Use the corrected border flow calculation
                border_flows = client._calculate_border_flows(raw_data)
                
                # Get the old values for comparison
                old_imports = record.imports or 0
                old_exports = record.exports or 0
                
                # Update with corrected values
                new_imports = border_flows["imports"]
                new_exports = border_flows["exports"]
                
                # Only update if values are different
                if old_imports != new_imports or old_exports != new_exports:
                    record.imports = new_imports
                    record.exports = new_exports
                    
                    print(f"📅 {record.timestamp}: Imports {old_imports} → {new_imports}, Exports {old_exports} → {new_exports}")
                    updated_count += 1
                else:
                    print(f"✅ {record.timestamp}: Values already correct (Imports: {new_imports}, Exports: {new_exports})")
                
            except Exception as e:
                print(f"❌ Error processing record {record.timestamp}: {e}")
                error_count += 1
                continue
        
        # Commit all changes
        if updated_count > 0:
            session.commit()
            print(f"\n✅ Successfully updated {updated_count} records")
        else:
            print(f"\n✅ No records needed updating")
        
        if error_count > 0:
            print(f"⚠️ {error_count} records had errors")
        
        print(f"\n📋 Summary:")
        print(f"   Total records processed: {len(records)}")
        print(f"   Records updated: {updated_count}")
        print(f"   Records with errors: {error_count}")
        print(f"   Records already correct: {len(records) - updated_count - error_count}")
        
        return True
        
    except Exception as e:
        session.rollback()
        print(f"❌ Database error: {e}")
        return False
    finally:
        session.close()

def verify_fix():
    """Verify that the fix worked by checking recent records."""
    print(f"\n🔍 Verifying Fix...")
    print("=" * 30)
    
    session = get_session()
    
    try:
        # Get the last 5 records to verify
        recent_records = session.query(PowerGenerationData)\
            .order_by(PowerGenerationData.timestamp.desc())\
            .limit(5)\
            .all()
        
        client = TranselectricaClient()
        
        for record in recent_records:
            if record.raw_data:
                try:
                    # Recalculate what the values should be
                    raw_data = json.loads(record.raw_data)
                    border_flows = client._calculate_border_flows(raw_data)
                    
                    expected_imports = border_flows["imports"]
                    expected_exports = border_flows["exports"]
                    
                    actual_imports = record.imports or 0
                    actual_exports = record.exports or 0
                    
                    imports_match = abs(expected_imports - actual_imports) < 0.1
                    exports_match = abs(expected_exports - actual_exports) < 0.1
                    
                    status = "✅" if imports_match and exports_match else "❌"
                    
                    print(f"{status} {record.timestamp}: Imports {actual_imports} (expected {expected_imports}), Exports {actual_exports} (expected {expected_exports})")
                    
                except Exception as e:
                    print(f"❌ Error verifying {record.timestamp}: {e}")
            else:
                print(f"⚠️ {record.timestamp}: No raw data available for verification")
        
    finally:
        session.close()

if __name__ == "__main__":
    if fix_historical_imports_exports():
        verify_fix()
        print(f"\n🎉 Historical imports/exports fix completed!")
    else:
        print(f"\n💥 Fix failed!")
