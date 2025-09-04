#!/usr/bin/env python3
"""
Comprehensive debug script to compare direct API calls vs web API endpoint
to identify why import/export values differ.
"""

import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import requests
import json
from datetime import datetime
from src.api.transelectrica_client import TranselectricaClient
from src.data.power_generation_collector import PowerGenerationCollector

def test_direct_api():
    """Test direct API call to TranselectricaClient."""
    print("=" * 60)
    print("🔍 TESTING DIRECT API CALL")
    print("=" * 60)
    
    try:
        client = TranselectricaClient()
        data = client.fetch_power_data()
        
        if data:
            print(f"✅ Direct API call successful")
            print(f"📊 Total Production: {data['totals']['production']:.1f} MW")
            print(f"📊 Total Consumption: {data['totals']['consumption']:.1f} MW")
            print(f"📊 Imports Total: {data.get('imports_total', 0):.1f} MW")
            print(f"📊 Exports Total: {data.get('exports_total', 0):.1f} MW")
            
            # Show border point details
            if 'import_export_units' in data:
                print(f"\n🌍 Border Point Details:")
                for unit, value in data['import_export_units'].items():
                    if value != 0:
                        direction = "Import" if value > 0 else "Export"
                        print(f"  {unit}: {value:.1f} MW ({direction})")
            
            return data
        else:
            print("❌ Direct API call failed - no data returned")
            return None
            
    except Exception as e:
        print(f"❌ Direct API call failed: {str(e)}")
        return None

def test_power_collector():
    """Test PowerGenerationCollector.get_latest_data()."""
    print("\n" + "=" * 60)
    print("🔍 TESTING POWER COLLECTOR")
    print("=" * 60)
    
    try:
        collector = PowerGenerationCollector()
        data = collector.get_latest_data()
        
        if data:
            print(f"✅ Power collector successful")
            print(f"📊 Total Production: {data['totals']['production']:.1f} MW")
            print(f"📊 Total Consumption: {data['totals']['consumption']:.1f} MW")
            print(f"📊 Imports Total: {data.get('imports_total', data['totals'].get('imports', 0)):.1f} MW")
            print(f"📊 Exports Total: {data.get('exports_total', data['totals'].get('exports', 0)):.1f} MW")
            
            return data
        else:
            print("❌ Power collector failed - no data returned")
            return None
            
    except Exception as e:
        print(f"❌ Power collector failed: {str(e)}")
        return None

def test_web_api_endpoint():
    """Test the web API endpoint."""
    print("\n" + "=" * 60)
    print("🔍 TESTING WEB API ENDPOINT")
    print("=" * 60)
    
    try:
        # Test the power generation intervals endpoint
        response = requests.get('http://localhost:8000/api/power-generation-intervals')
        
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Web API endpoint successful")
            
            # Find current interval
            current_interval = None
            for interval in data['intervals']:
                if interval['is_current']:
                    current_interval = interval
                    break
            
            if current_interval:
                print(f"📊 Current Interval: {current_interval['interval']}")
                print(f"📊 Production: {current_interval.get('production', 'N/A')} MW")
                print(f"📊 Consumption: {current_interval.get('consumption', 'N/A')} MW")
                print(f"📊 Imports: {current_interval.get('imports', 'N/A')} MW")
                print(f"📊 Exports: {current_interval.get('exports', 'N/A')} MW")
                
                # Show interconnection details if available
                if 'interconnection_details' in current_interval:
                    print(f"\n🌍 Interconnection Details:")
                    for country, flow in current_interval['interconnection_details'].items():
                        if flow != 0:
                            direction = "Import" if flow < 0 else "Export"
                            print(f"  {country}: {abs(flow):.1f} MW ({direction})")
                
                return current_interval
            else:
                print("⚠️ No current interval found in web API response")
                return None
        else:
            print(f"❌ Web API endpoint failed with status {response.status_code}")
            print(f"Response: {response.text}")
            return None
            
    except Exception as e:
        print(f"❌ Web API endpoint failed: {str(e)}")
        return None

def test_fresh_collector_in_endpoint():
    """Test creating a fresh collector like the web endpoint does."""
    print("\n" + "=" * 60)
    print("🔍 TESTING FRESH COLLECTOR (LIKE WEB ENDPOINT)")
    print("=" * 60)
    
    try:
        # Force reload like the web endpoint does
        import importlib
        import src.api.transelectrica_client
        importlib.reload(src.api.transelectrica_client)
        
        # Create fresh collector
        from src.data.power_generation_collector import PowerGenerationCollector
        fresh_collector = PowerGenerationCollector()
        
        # Get live API data like the web endpoint does for current intervals
        live_api_data = fresh_collector.client.fetch_power_data()
        
        if live_api_data:
            print(f"✅ Fresh collector live API successful")
            print(f"📊 Total Production: {live_api_data['totals']['production']:.1f} MW")
            print(f"📊 Total Consumption: {live_api_data['totals']['consumption']:.1f} MW")
            print(f"📊 Imports Total: {live_api_data.get('imports_total', 0):.1f} MW")
            print(f"📊 Exports Total: {live_api_data.get('exports_total', 0):.1f} MW")
            
            return live_api_data
        else:
            print("❌ Fresh collector live API failed - no data returned")
            return None
            
    except Exception as e:
        print(f"❌ Fresh collector failed: {str(e)}")
        return None

def compare_results(direct_data, collector_data, web_data, fresh_data):
    """Compare all results to identify discrepancies."""
    print("\n" + "=" * 60)
    print("🔍 COMPARISON ANALYSIS")
    print("=" * 60)
    
    # Extract import values from each source
    results = {}
    
    if direct_data:
        results['Direct API'] = direct_data.get('imports_total', 0)
    
    if collector_data:
        results['Power Collector'] = collector_data.get('imports_total', collector_data['totals'].get('imports', 0))
    
    if web_data:
        results['Web API Endpoint'] = web_data.get('imports', 0)
    
    if fresh_data:
        results['Fresh Collector'] = fresh_data.get('imports_total', 0)
    
    print("📊 IMPORT VALUES COMPARISON:")
    for source, value in results.items():
        print(f"  {source}: {value:.1f} MW")
    
    # Check for discrepancies
    values = list(results.values())
    if len(set(values)) > 1:
        print("\n⚠️ DISCREPANCY DETECTED!")
        max_val = max(values)
        min_val = min(values)
        print(f"   Range: {min_val:.1f} - {max_val:.1f} MW")
        print(f"   Difference: {max_val - min_val:.1f} MW")
        
        # Identify which sources match
        print("\n🔍 MATCHING SOURCES:")
        for i, (source1, val1) in enumerate(results.items()):
            matches = [source1]
            for j, (source2, val2) in enumerate(results.items()):
                if i != j and abs(val1 - val2) < 0.1:  # Allow small floating point differences
                    matches.append(source2)
            if len(matches) > 1:
                print(f"   {val1:.1f} MW: {', '.join(matches)}")
    else:
        print("\n✅ ALL SOURCES MATCH!")

def main():
    """Run comprehensive comparison test."""
    print("🚀 COMPREHENSIVE WEB API DEBUG COMPARISON")
    print("Testing all data sources to identify import/export discrepancy")
    print(f"⏰ Test time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Test all sources
    direct_data = test_direct_api()
    collector_data = test_power_collector()
    fresh_data = test_fresh_collector_in_endpoint()
    web_data = test_web_api_endpoint()
    
    # Compare results
    compare_results(direct_data, collector_data, web_data, fresh_data)
    
    print("\n" + "=" * 60)
    print("🏁 DEBUG COMPARISON COMPLETE")
    print("=" * 60)

if __name__ == "__main__":
    main()
