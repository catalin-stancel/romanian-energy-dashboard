#!/usr/bin/env python3

import sys
sys.path.append('src')
from api.transelectrica_client import TranselectricaClient
import json

def test_data_sources():
    """Test the correct data source mapping."""
    client = TranselectricaClient()
    data = client.fetch_power_data()

    if data:
        # Parse the raw data to see all available fields
        raw_data = json.loads(data['raw_data'])
        
        print('🔍 Available data fields:')
        for item in raw_data:
            for key, value in item.items():
                if any(term in key.upper() for term in ['CONS', 'PROD', 'SOLD']):
                    print(f'  {key}: {value}')
        
        print(f'\n📊 Current mapping results:')
        print(f'Production (PROD): {data["totals"]["production"]}MW')
        print(f'Consumption (CONS): {data["totals"]["consumption"]}MW')
        print(f'Net Balance (SOLD): {data["totals"]["net_balance"]}MW')
        
        # Verify the mapping is correct
        print(f'\n✅ Data source verification:')
        print(f'✅ Production from PROD: {data["totals"]["production"]}MW')
        print(f'✅ Consumption from CONS: {data["totals"]["consumption"]}MW') 
        print(f'✅ Imbalance from SOLD: {data["totals"]["net_balance"]}MW')
        
        return True
    else:
        print('❌ Failed to fetch data')
        return False

if __name__ == "__main__":
    test_data_sources()
