#!/usr/bin/env python3
"""
Debug script to examine ENTSO-E XML response for price data.
"""

import sys
import os
sys.path.append(os.path.dirname(__file__))

from src.api.entsoe_client import ENTSOEClient
from datetime import datetime, timedelta
import xml.etree.ElementTree as ET

def debug_xml_response():
    client = ENTSOEClient()
    
    # Get yesterday's data
    end_date = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    start_date = end_date - timedelta(days=1)
    
    print(f"Fetching price data from {start_date} to {end_date}")
    
    # Make the API request manually to get raw XML
    params = {
        'documentType': 'A85',
        'ControlArea_Domain': '10YRO-TEL------P',
        'periodStart': client._format_datetime(start_date),
        'periodEnd': client._format_datetime(end_date),
        'securityToken': client.token
    }
    
    try:
        response = client._make_request(params)
        xml_content = client._extract_xml_from_response(response)
        
        print("=" * 80)
        print("FULL XML RESPONSE:")
        print("=" * 80)
        print(xml_content)
        print("=" * 80)
        
        # Parse and analyze structure
        root = ET.fromstring(xml_content)
        print(f"\nRoot element: {root.tag}")
        print(f"Root namespace: {root.tag.split('}')[0][1:] if '}' in root.tag else 'None'}")
        
        print("\nAll elements in document:")
        for elem in root.iter():
            print(f"  {elem.tag} = {elem.text if elem.text and elem.text.strip() else '(no text)'}")
        
        print("\nLooking for TimeSeries elements:")
        timeseries_elements = root.findall('.//{*}TimeSeries')
        print(f"Found {len(timeseries_elements)} TimeSeries elements")
        
        for i, ts in enumerate(timeseries_elements):
            print(f"\nTimeSeries {i+1}:")
            for elem in ts.iter():
                if elem.text and elem.text.strip():
                    print(f"  {elem.tag} = {elem.text}")
        
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    debug_xml_response()
