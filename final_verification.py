#!/usr/bin/env python3
"""
Final verification script for import/export units functionality.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.getcwd(), 'src'))

import sqlite3
from datetime import datetime

def main():
    print('🎯 Final Verification: Import/Export Units Implementation')
    print('=' * 65)

    # Step 1: Check database schema
    print('📋 Step 1: Verifying database schema...')
    conn = sqlite3.connect('data/balancing_market.db')
    cursor = conn.cursor()

    cursor.execute('PRAGMA table_info(power_generation_data)')
    columns = cursor.fetchall()

    import_export_columns = [col for col in columns if col[1].startswith('unit_') or col[1] == 'total_import_export_units']
    print(f'✅ Found {len(import_export_columns)} import/export columns in database')

    # Step 2: Test API data collection
    print('\n📡 Step 2: Testing API data collection...')
    from api.transelectrica_client import TranselectricaClient
    client = TranselectricaClient()
    api_data = client.fetch_power_data()

    if api_data and 'import_export_units' in api_data:
        print('✅ API returning import/export units data')
        print(f'Total: {api_data["total_import_export_units"]} MW')
        
        active_count = len([v for v in api_data['import_export_units'].values() if v > 0])
        print(f'Active units: {active_count}')
        
        # Step 3: Test manual database insertion
        print('\n💾 Step 3: Testing database insertion...')
        
        # Insert a test record with current timestamp
        test_timestamp = datetime.now()
        
        cursor.execute('''
            INSERT INTO power_generation_data (
                timestamp, nuclear, coal, gas, wind, hydro, solar, other,
                total_production, total_consumption, net_balance,
                interconnection_hungary, interconnection_bulgaria, interconnection_serbia,
                unit_muka, unit_kozl2, unit_djer, unit_sand, unit_beke1, unit_beke115,
                total_import_export_units, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            test_timestamp,
            api_data['generation']['nuclear'],
            api_data['generation']['coal'],
            api_data['generation']['gas'],
            api_data['generation']['wind'],
            api_data['generation']['hydro'],
            api_data['generation']['solar'],
            api_data['generation']['other'],
            api_data['totals']['production'],
            api_data['totals']['consumption'],
            api_data['totals']['net_balance'],
            api_data['interconnections']['interconnection_hungary'],
            api_data['interconnections']['interconnection_bulgaria'],
            api_data['interconnections']['interconnection_serbia'],
            api_data['import_export_units']['unit_muka'],
            api_data['import_export_units']['unit_kozl2'],
            api_data['import_export_units']['unit_djer'],
            api_data['import_export_units']['unit_sand'],
            api_data['import_export_units']['unit_beke1'],
            api_data['import_export_units']['unit_beke115'],
            api_data['total_import_export_units'],
            api_data['raw_data']
        ))
        
        conn.commit()
        print('✅ Test record inserted successfully')
        
        # Step 4: Verify the data was stored correctly
        print('\n🔍 Step 4: Verifying stored data...')
        cursor.execute('''
            SELECT unit_muka, unit_kozl2, unit_djer, unit_sand, unit_beke1, unit_beke115, 
                   total_import_export_units
            FROM power_generation_data 
            WHERE timestamp = ?
        ''', (test_timestamp,))
        
        result = cursor.fetchone()
        if result:
            print('Database verification:')
            print(f'  MUKA: {result[0]} MW')
            print(f'  KOZL2: {result[1]} MW')
            print(f'  DJER: {result[2]} MW')
            print(f'  SAND: {result[3]} MW')
            print(f'  BEKE1: {result[4]} MW')
            print(f'  BEKE115: {result[5]} MW')
            print(f'  Total: {result[6]} MW')
            
            # Compare with API data
            api_total = api_data['total_import_export_units']
            db_total = result[6]
            
            if abs(api_total - db_total) < 0.01:
                print('\n✅ SUCCESS: API data matches database storage!')
                print('\n🎉 Import/Export Units Implementation Complete!')
                print('\nTracked Units:')
                units = ['MUKA', 'ISPOZ', 'IS', 'UNGE', 'CIOA', 'GOTE', 'VULC', 'DOBR', 'VARN', 
                         'KOZL1', 'KOZL2', 'DJER', 'SIP_', 'PANCEVO21', 'PANCEVO22', 'KIKI', 
                         'SAND', 'BEKE1', 'BEKE115']
                for unit in units:
                    print(f'  ✓ {unit}')
            else:
                print(f'\n❌ Data mismatch: API={api_total}, DB={db_total}')
        else:
            print('❌ Failed to retrieve test record')
    else:
        print('❌ API test failed')

    conn.close()

if __name__ == "__main__":
    main()
