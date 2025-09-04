#!/usr/bin/env python3
"""
Script to check the detailed imports and exports data saved in the database.
"""

import sqlite3
from datetime import datetime

def check_imports_exports_data():
    """Check the detailed imports and exports data in the database."""
    print("🔍 Checking imports and exports data in database...\n")
    
    conn = sqlite3.connect('data/balancing_market.db')
    cursor = conn.cursor()
    
    # Get all records with detailed import/export information
    cursor.execute("""
        SELECT 
            timestamp,
            total_production,
            total_consumption,
            net_balance,
            imports,
            exports,
            total_import_export_units,
            interconnection_hungary,
            interconnection_bulgaria,
            interconnection_serbia,
            unit_muka,
            unit_ispoz,
            unit_is,
            unit_unge,
            unit_cioa,
            unit_gote,
            unit_vulc,
            unit_dobr,
            unit_varn,
            unit_kozl1,
            unit_kozl2,
            unit_djer,
            unit_sip,
            unit_pancevo21,
            unit_pancevo22,
            unit_kiki,
            unit_sand,
            unit_beke1,
            unit_beke115
        FROM power_generation_data
        ORDER BY timestamp DESC
    """)
    
    records = cursor.fetchall()
    
    if not records:
        print("❌ No records found in database")
        conn.close()
        return
    
    print(f"📊 Found {len(records)} record(s) in database\n")
    
    for i, record in enumerate(records):
        timestamp = record[0]
        total_production = record[1]
        total_consumption = record[2]
        net_balance = record[3]
        imports = record[4]
        exports = record[5]
        total_import_export_units = record[6]
        
        # Interconnections
        interconnection_hungary = record[7]
        interconnection_bulgaria = record[8]
        interconnection_serbia = record[9]
        
        # Individual border units
        border_units = {
            'unit_muka': record[10],
            'unit_ispoz': record[11],
            'unit_is': record[12],
            'unit_unge': record[13],
            'unit_cioa': record[14],
            'unit_gote': record[15],
            'unit_vulc': record[16],
            'unit_dobr': record[17],
            'unit_varn': record[18],
            'unit_kozl1': record[19],
            'unit_kozl2': record[20],
            'unit_djer': record[21],
            'unit_sip': record[22],
            'unit_pancevo21': record[23],
            'unit_pancevo22': record[24],
            'unit_kiki': record[25],
            'unit_sand': record[26],
            'unit_beke1': record[27],
            'unit_beke115': record[28]
        }
        
        print(f"🕐 Record {i+1}: {timestamp}")
        print(f"   📈 Production: {total_production} MW")
        print(f"   📉 Consumption: {total_consumption} MW")
        print(f"   ⚖️  Net Balance: {net_balance} MW")
        print(f"   📥 Imports: {imports} MW")
        print(f"   📤 Exports: {exports} MW")
        print(f"   🔄 Total Import/Export Units: {total_import_export_units} MW")
        
        print(f"\n   🌐 Interconnections:")
        print(f"      Hungary: {interconnection_hungary} MW")
        print(f"      Bulgaria: {interconnection_bulgaria} MW")
        print(f"      Serbia: {interconnection_serbia} MW")
        
        print(f"\n   🏭 Individual Border Units:")
        for unit_name, value in border_units.items():
            if value != 0.0 and value is not None:
                unit_display = unit_name.replace('unit_', '').upper()
                print(f"      {unit_display}: {value} MW")
        
        # Check for units with zero values
        zero_units = [name for name, value in border_units.items() if value == 0.0 or value is None]
        if zero_units:
            print(f"\n   ⚪ Zero/Null Units ({len(zero_units)}):")
            zero_display = [name.replace('unit_', '').upper() for name in zero_units]
            print(f"      {', '.join(zero_display)}")
        
        # Calculate verification
        positive_units = sum(value for value in border_units.values() if value and value > 0)
        negative_units = sum(abs(value) for value in border_units.values() if value and value < 0)
        
        print(f"\n   🧮 Calculation Verification:")
        print(f"      Positive units (imports): {positive_units} MW")
        print(f"      Negative units (exports): {negative_units} MW")
        print(f"      Calculated imports: {positive_units} MW (DB: {imports} MW)")
        print(f"      Calculated exports: {negative_units} MW (DB: {exports} MW)")
        
        if abs(positive_units - (imports or 0)) > 0.1:
            print(f"      ⚠️  Import calculation mismatch!")
        if abs(negative_units - (exports or 0)) > 0.1:
            print(f"      ⚠️  Export calculation mismatch!")
        
        print("-" * 80)
    
    conn.close()

def check_raw_data():
    """Check if raw data is stored for debugging."""
    print("\n🔍 Checking raw data storage...\n")
    
    conn = sqlite3.connect('data/balancing_market.db')
    cursor = conn.cursor()
    
    cursor.execute("SELECT timestamp, raw_data FROM power_generation_data ORDER BY timestamp DESC LIMIT 1")
    record = cursor.fetchone()
    
    if record and record[1]:
        print(f"📋 Raw data found for {record[0]}:")
        print(f"   Length: {len(record[1])} characters")
        print(f"   Preview: {record[1][:200]}...")
    else:
        print("❌ No raw data found")
    
    conn.close()

def main():
    print("🔍 Detailed Imports/Exports Data Analysis\n")
    print("=" * 80)
    
    check_imports_exports_data()
    check_raw_data()
    
    print("\n🎉 Analysis completed!")

if __name__ == "__main__":
    main()
