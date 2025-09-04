#!/usr/bin/env python3
"""
Debug script for import/export units functionality.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.getcwd(), 'src'))

from api.transelectrica_client import TranselectricaClient
from data.power_generation_collector import PowerGenerationCollector
import sqlite3
import logging

def main():
    logging.basicConfig(level=logging.INFO)
    
    print('🔧 Debugging Import/Export Units Data Collection')
    print('=' * 60)
    
    # Step 1: Test API client directly
    print('📡 Step 1: Testing API client directly...')
    client = TranselectricaClient()
    api_data = client.fetch_power_data()
    
    if api_data:
        print('✅ API client working')
        print(f'Total from API: {api_data["total_import_export_units"]} MW')
        
        active_api_units = {k: v for k, v in api_data['import_export_units'].items() if v > 0}
        if active_api_units:
            print('Active units from API:')
            for unit, value in sorted(active_api_units.items(), key=lambda x: x[1], reverse=True):
                unit_name = unit.replace('unit_', '').upper()
                print(f'  {unit_name}: {value} MW')
        
        # Step 2: Test collector
        print('\n📊 Step 2: Testing collector with force update...')
        collector = PowerGenerationCollector()
        success = collector.collect_current_data(force_update=True)
        
        if success:
            print('✅ Collector succeeded')
            
            # Step 3: Check what was actually stored
            print('\n🔍 Step 3: Checking database immediately after collection...')
            conn = sqlite3.connect('data/balancing_market.db')
            cursor = conn.cursor()
            
            cursor.execute('''
                SELECT unit_muka, unit_kozl2, unit_djer, unit_sand, unit_beke1, unit_beke115, 
                       total_import_export_units
                FROM power_generation_data 
                ORDER BY id DESC 
                LIMIT 1
            ''')
            
            db_result = cursor.fetchone()
            if db_result:
                print('Database shows:')
                print(f'  MUKA: {db_result[0]} MW')
                print(f'  KOZL2: {db_result[1]} MW') 
                print(f'  DJER: {db_result[2]} MW')
                print(f'  SAND: {db_result[3]} MW')
                print(f'  BEKE1: {db_result[4]} MW')
                print(f'  BEKE115: {db_result[5]} MW')
                print(f'  Total: {db_result[6]} MW')
                
                # Compare API vs Database
                print('\n🔍 Step 4: Comparison:')
                api_total = api_data["total_import_export_units"]
                db_total = db_result[6]
                print(f'  API Total: {api_total} MW')
                print(f'  DB Total: {db_total} MW')
                
                if abs(api_total - db_total) < 0.01:
                    print('  ✅ Data matches!')
                else:
                    print('  ❌ Data mismatch - investigating...')
                    
                    # Check individual units
                    api_muka = api_data['import_export_units']['unit_muka']
                    db_muka = db_result[0]
                    print(f'  MUKA - API: {api_muka}, DB: {db_muka}')
            
            conn.close()
        else:
            print('❌ Collector failed')
    else:
        print('❌ API client failed')

if __name__ == "__main__":
    main()
