#!/usr/bin/env python3

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.api.transelectrica_client import TranselectricaClient
from src.data.models import PowerGenerationData
from sqlalchemy import create_engine, desc
from sqlalchemy.orm import sessionmaker
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def debug_import_export_values():
    """Debug the import/export values calculation and storage."""
    
    print("🔍 Debugging Import/Export Values...")
    
    # 1. Fetch current data from Transelectrica API
    print("\n1. Fetching current data from Transelectrica API...")
    client = TranselectricaClient()
    current_data = client.fetch_power_data()
    
    if current_data:
        print(f"✅ Successfully fetched data at {current_data['timestamp']}")
        print(f"📊 Total Production: {current_data['totals']['production']:.0f} MW")
        print(f"📊 Total Consumption: {current_data['totals']['consumption']:.0f} MW")
        
        print(f"\n🔌 Import/Export Units Data:")
        total_abs = 0
        total_sum = 0
        positive_sum = 0
        negative_sum = 0
        
        for unit, value in current_data['import_export_units'].items():
            if value != 0:
                print(f"  {unit}: {value:.0f} MW")
            total_abs += abs(value)
            total_sum += value
            if value > 0:
                positive_sum += value
            else:
                negative_sum += value
        
        print(f"\n📈 Calculations:")
        print(f"  Total absolute sum: {total_abs:.0f} MW")
        print(f"  Total algebraic sum: {total_sum:.0f} MW")
        print(f"  Positive values sum (imports): {positive_sum:.0f} MW")
        print(f"  Negative values sum: {negative_sum:.0f} MW")
        print(f"  Absolute negative sum (exports): {abs(negative_sum):.0f} MW")
        
        print(f"\n🎯 API Results:")
        print(f"  total_import_export_units: {current_data['total_import_export_units']:.0f} MW")
        print(f"  imports_total: {current_data['imports_total']:.0f} MW")
        print(f"  exports_total: {current_data['exports_total']:.0f} MW")
        print(f"  totals.imports: {current_data['totals']['imports']:.0f} MW")
        print(f"  totals.exports: {current_data['totals']['exports']:.0f} MW")
    else:
        print("❌ Failed to fetch current data")
        return
    
    # 2. Check what's stored in the database
    print("\n2. Checking database values...")
    try:
        engine = create_engine('sqlite:///data/balancing_market.db')
        Session = sessionmaker(bind=engine)
        session = Session()
        
        # Get the most recent record
        latest_record = session.query(PowerGenerationData).order_by(desc(PowerGenerationData.timestamp)).first()
        
        if latest_record:
            print(f"✅ Latest database record at {latest_record.timestamp}")
            print(f"📊 Production: {latest_record.total_production:.0f} MW")
            print(f"📊 Consumption: {latest_record.total_consumption:.0f} MW")
            
            if hasattr(latest_record, 'imports') and hasattr(latest_record, 'exports'):
                print(f"🔌 Database imports: {latest_record.imports:.0f} MW")
                print(f"🔌 Database exports: {latest_record.exports:.0f} MW")
            else:
                print("❌ No imports/exports columns found in database")
            
            # Check individual unit values
            print(f"\n🔌 Individual unit values in database:")
            unit_fields = [
                'unit_muka', 'unit_ispoz', 'unit_is', 'unit_unge', 'unit_cioa',
                'unit_gote', 'unit_vulc', 'unit_dobr', 'unit_varn', 'unit_kozl1',
                'unit_kozl2', 'unit_djer', 'unit_sip', 'unit_pancevo21', 'unit_pancevo22',
                'unit_kiki', 'unit_sand', 'unit_beke1', 'unit_beke115'
            ]
            
            db_total_abs = 0
            db_total_sum = 0
            db_positive_sum = 0
            db_negative_sum = 0
            
            for field in unit_fields:
                if hasattr(latest_record, field):
                    value = getattr(latest_record, field, 0) or 0
                    if value != 0:
                        print(f"  {field}: {value:.0f} MW")
                    db_total_abs += abs(value)
                    db_total_sum += value
                    if value > 0:
                        db_positive_sum += value
                    else:
                        db_negative_sum += value
            
            print(f"\n📈 Database Calculations:")
            print(f"  Total absolute sum: {db_total_abs:.0f} MW")
            print(f"  Total algebraic sum: {db_total_sum:.0f} MW")
            print(f"  Positive values sum: {db_positive_sum:.0f} MW")
            print(f"  Negative values sum: {db_negative_sum:.0f} MW")
            print(f"  Absolute negative sum: {abs(db_negative_sum):.0f} MW")
            
        else:
            print("❌ No records found in database")
        
        session.close()
        
    except Exception as e:
        print(f"❌ Database error: {e}")
    
    print("\n✅ Debug complete!")

if __name__ == "__main__":
    debug_import_export_values()
