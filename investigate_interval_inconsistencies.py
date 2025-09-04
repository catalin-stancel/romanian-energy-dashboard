#!/usr/bin/env python3
"""
Comprehensive investigation of interval inconsistencies in Power generation Data table.
This script will compare current live API data with stored database values to identify discrepancies.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.data.models import PowerGenerationData, get_session
from src.data.power_generation_collector import PowerGenerationCollector
from datetime import datetime, timedelta
import pytz
import json

def investigate_interval_inconsistencies():
    """Investigate inconsistencies between current and historical intervals."""
    print("🔍 INVESTIGATING INTERVAL INCONSISTENCIES")
    print("=" * 80)
    
    # Romanian timezone
    romanian_tz = pytz.timezone('Europe/Bucharest')
    current_time = datetime.now(romanian_tz)
    
    # Create fresh collector
    collector = PowerGenerationCollector()
    
    print(f"📅 Current time: {current_time}")
    print(f"🕐 Current interval: {get_current_interval_number(current_time)}")
    
    # 1. Get current live API data
    print("\n1️⃣ FETCHING CURRENT LIVE API DATA")
    print("-" * 50)
    
    live_api_data = collector.client.fetch_power_data()
    if live_api_data:
        print("✅ Live API data retrieved successfully")
        print(f"   Production: {live_api_data['totals']['production']} MW")
        print(f"   Consumption: {live_api_data['totals']['consumption']} MW")
        print(f"   Imports Total: {live_api_data.get('imports_total', 'N/A')} MW")
        print(f"   Exports Total: {live_api_data.get('exports_total', 'N/A')} MW")
        
        # Calculate net balance from live data
        live_net_balance = live_api_data['totals']['production'] - live_api_data['totals']['consumption']
        print(f"   Calculated Net Balance: {live_net_balance:.1f} MW")
    else:
        print("❌ Failed to retrieve live API data")
        return
    
    # 2. Get latest stored data
    print("\n2️⃣ FETCHING LATEST STORED DATA")
    print("-" * 50)
    
    latest_stored_data = collector.get_latest_data()
    if latest_stored_data:
        print("✅ Latest stored data retrieved")
        print(f"   Timestamp: {latest_stored_data['timestamp']}")
        print(f"   Production: {latest_stored_data['totals']['production']} MW")
        print(f"   Consumption: {latest_stored_data['totals']['consumption']} MW")
        print(f"   Net Balance: {latest_stored_data['totals']['net_balance']} MW")
        print(f"   Imports: {latest_stored_data['totals'].get('imports', 'N/A')} MW")
        print(f"   Exports: {latest_stored_data['totals'].get('exports', 'N/A')} MW")
    else:
        print("❌ No latest stored data available")
        return
    
    # 3. Compare current live vs latest stored
    print("\n3️⃣ COMPARING LIVE VS STORED DATA")
    print("-" * 50)
    
    production_diff = live_api_data['totals']['production'] - latest_stored_data['totals']['production']
    consumption_diff = live_api_data['totals']['consumption'] - latest_stored_data['totals']['consumption']
    
    print(f"   Production difference: {production_diff:.1f} MW")
    print(f"   Consumption difference: {consumption_diff:.1f} MW")
    
    if abs(production_diff) > 10 or abs(consumption_diff) > 10:
        print("   ⚠️ SIGNIFICANT DIFFERENCES DETECTED!")
    else:
        print("   ✅ Values are reasonably close")
    
    # 4. Check specific problematic intervals from database
    print("\n4️⃣ CHECKING SPECIFIC PROBLEMATIC INTERVALS")
    print("-" * 50)
    
    session = get_session()
    try:
        # Check today's intervals
        today = current_time.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
        tomorrow = today + timedelta(days=1)
        
        # Get all today's records
        today_records = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp >= today)\
            .filter(PowerGenerationData.timestamp < tomorrow)\
            .order_by(PowerGenerationData.timestamp)\
            .all()
        
        print(f"   Found {len(today_records)} records for today")
        
        if today_records:
            print("\n   📊 TODAY'S STORED INTERVALS:")
            for i, record in enumerate(today_records[-10:]):  # Show last 10 records
                interval_num = get_interval_number_from_timestamp(record.timestamp)
                calculated_net = record.total_production - record.total_consumption
                stored_net = record.net_balance
                net_diff = calculated_net - stored_net
                
                print(f"     Interval {interval_num:2d} ({record.timestamp.strftime('%H:%M')}): "
                      f"Prod={record.total_production:6.1f} MW, "
                      f"Cons={record.total_consumption:6.1f} MW, "
                      f"Net(calc)={calculated_net:6.1f} MW, "
                      f"Net(stored)={stored_net:6.1f} MW, "
                      f"Diff={net_diff:5.1f} MW")
                
                if abs(net_diff) > 1:
                    print(f"       ⚠️ Net balance calculation inconsistency!")
        
        # 5. Check specific intervals mentioned in test files (14:45, 16:00)
        print("\n5️⃣ CHECKING SPECIFIC MENTIONED INTERVALS")
        print("-" * 50)
        
        # Check 14:45 interval
        time_1445 = today.replace(hour=14, minute=45)
        record_1445 = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == time_1445)\
            .first()
        
        if record_1445:
            print(f"   📍 14:45 INTERVAL DETAILS:")
            print(f"     Production: {record_1445.total_production} MW")
            print(f"     Consumption: {record_1445.total_consumption} MW")
            print(f"     Net Balance (stored): {record_1445.net_balance} MW")
            print(f"     Net Balance (calculated): {record_1445.total_production - record_1445.total_consumption} MW")
            print(f"     Imports: {record_1445.imports} MW")
            print(f"     Exports: {record_1445.exports} MW")
            
            # Check border point values
            border_values = [
                ('MUKA', record_1445.unit_muka),
                ('ISPOZ', record_1445.unit_ispoz),
                ('IS', record_1445.unit_is),
                ('UNGE', record_1445.unit_unge),
                ('CIOA', record_1445.unit_cioa),
                ('GOTE', record_1445.unit_gote),
                ('VULC', record_1445.unit_vulc),
                ('DOBR', record_1445.unit_dobr),
                ('VARN', record_1445.unit_varn),
                ('KOZL1', record_1445.unit_kozl1),
                ('KOZL2', record_1445.unit_kozl2),
                ('DJER', record_1445.unit_djer),
                ('SIP_', record_1445.unit_sip),
                ('PANCEVO21', record_1445.unit_pancevo21),
                ('PANCEVO22', record_1445.unit_pancevo22),
                ('KIKI', record_1445.unit_kiki),
                ('SAND', record_1445.unit_sand),
                ('BEKE1', record_1445.unit_beke1),
                ('BEKE115', record_1445.unit_beke115),
            ]
            
            calc_imports = sum(v for _, v in border_values if v and v > 0)
            calc_exports = sum(-v for _, v in border_values if v and v < 0)
            
            print(f"     Border Points Calculated Imports: {calc_imports} MW")
            print(f"     Border Points Calculated Exports: {calc_exports} MW")
            print(f"     Stored Imports: {record_1445.imports} MW")
            print(f"     Stored Exports: {record_1445.exports} MW")
            
            if abs(calc_imports - (record_1445.imports or 0)) > 0.1:
                print(f"       ⚠️ IMPORTS CALCULATION MISMATCH!")
            if abs(calc_exports - (record_1445.exports or 0)) > 0.1:
                print(f"       ⚠️ EXPORTS CALCULATION MISMATCH!")
        else:
            print("   ❌ No 14:45 record found")
        
        # Check 16:00 interval
        time_1600 = today.replace(hour=16, minute=0)
        record_1600 = session.query(PowerGenerationData)\
            .filter(PowerGenerationData.timestamp == time_1600)\
            .first()
        
        if record_1600:
            print(f"\n   📍 16:00 INTERVAL DETAILS:")
            print(f"     Production: {record_1600.total_production} MW")
            print(f"     Consumption: {record_1600.total_consumption} MW")
            print(f"     Net Balance (stored): {record_1600.net_balance} MW")
            print(f"     Net Balance (calculated): {record_1600.total_production - record_1600.total_consumption} MW")
            print(f"     Imports: {record_1600.imports} MW")
            print(f"     Exports: {record_1600.exports} MW")
        else:
            print("   ❌ No 16:00 record found")
    
    finally:
        session.close()
    
    # 6. Test web API consistency
    print("\n6️⃣ TESTING WEB API CONSISTENCY")
    print("-" * 50)
    
    try:
        import requests
        response = requests.get('http://localhost:5000/api/power-generation-intervals', timeout=10)
        if response.status_code == 200:
            api_data = response.json()
            current_interval = api_data.get('current_interval')
            
            if current_interval:
                # Find current interval data
                current_interval_data = None
                for interval in api_data['intervals']:
                    if interval['interval'] == current_interval:
                        current_interval_data = interval
                        break
                
                if current_interval_data:
                    print(f"   📡 WEB API CURRENT INTERVAL ({current_interval}):")
                    print(f"     Production: {current_interval_data.get('production')} MW")
                    print(f"     Consumption: {current_interval_data.get('consumption')} MW")
                    print(f"     Net Balance: {current_interval_data.get('net_balance')} MW")
                    print(f"     Imports: {current_interval_data.get('imports')} MW")
                    print(f"     Exports: {current_interval_data.get('exports')} MW")
                    
                    # Compare with live API data
                    if live_api_data:
                        prod_diff = current_interval_data.get('production', 0) - live_api_data['totals']['production']
                        cons_diff = current_interval_data.get('consumption', 0) - live_api_data['totals']['consumption']
                        
                        print(f"   🔄 COMPARISON WITH LIVE API:")
                        print(f"     Production difference: {prod_diff:.1f} MW")
                        print(f"     Consumption difference: {cons_diff:.1f} MW")
                        
                        if abs(prod_diff) > 10 or abs(cons_diff) > 10:
                            print("     ⚠️ SIGNIFICANT DIFFERENCES BETWEEN WEB API AND LIVE API!")
                        else:
                            print("     ✅ Web API and Live API are consistent")
        else:
            print(f"   ❌ Web API request failed: {response.status_code}")
    except Exception as e:
        print(f"   ❌ Web API test failed: {e}")
    
    print("\n" + "=" * 80)
    print("🎯 INVESTIGATION COMPLETE")
    print("=" * 80)

def get_current_interval_number(current_time):
    """Get the current 15-minute interval number (1-96)."""
    start_of_day = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
    minutes_since_start = (current_time - start_of_day).total_seconds() / 60
    interval_number = int(minutes_since_start // 15) + 1
    return min(interval_number, 96)

def get_interval_number_from_timestamp(timestamp):
    """Get interval number from timestamp."""
    start_of_day = timestamp.replace(hour=0, minute=0, second=0, microsecond=0)
    minutes_since_start = (timestamp - start_of_day).total_seconds() / 60
    interval_number = int(minutes_since_start // 15) + 1
    return min(interval_number, 96)

if __name__ == "__main__":
    investigate_interval_inconsistencies()
