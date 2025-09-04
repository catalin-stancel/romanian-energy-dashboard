#!/usr/bin/env python3
"""
Test script for the new import/export units functionality.
"""

import sys
sys.path.append('src')

from data.power_generation_collector import PowerGenerationCollector
import logging

def main():
    logging.basicConfig(level=logging.INFO)
    collector = PowerGenerationCollector()

    print('🔧 Testing Power Generation Collector with Import/Export Units...')

    # Test data collection
    print('📊 Collecting power generation data...')
    if collector.collect_current_data(force_update=True):
        print('✅ Data collection successful')
        
        # Test the API client directly to see the new data structure
        data = collector.client.fetch_power_data()
        if data:
            print(f'\n📊 Import/Export Units Data:')
            print(f'Total Import/Export Units: {data["total_import_export_units"]:.0f} MW')
            
            print('\n🏭 Individual Units:')
            for unit, value in data['import_export_units'].items():
                if value > 0:
                    print(f'  {unit.upper()}: {value:.0f} MW')
            
            print('\n🔌 Active Units (non-zero values):')
            active_units = {k: v for k, v in data['import_export_units'].items() if v > 0}
            if active_units:
                for unit, value in sorted(active_units.items(), key=lambda x: x[1], reverse=True):
                    unit_name = unit.replace('unit_', '').upper()
                    print(f'  {unit_name}: {value:.0f} MW')
            else:
                print('  No active units at this time')
            
            print('\n📋 All Units Status:')
            for unit, value in sorted(data['import_export_units'].items()):
                unit_name = unit.replace('unit_', '').upper()
                status = f'{value:.0f} MW' if value > 0 else 'Offline'
                print(f'  {unit_name}: {status}')
        
        print('\n🎉 Test completed successfully!')
    else:
        print('❌ Data collection failed')

if __name__ == "__main__":
    main()
