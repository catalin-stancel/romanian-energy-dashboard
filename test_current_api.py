import requests
import json

try:
    response = requests.get("http://localhost:8000/api/power-generation-intervals")
    data = response.json()
    
    current_intervals = [i for i in data['intervals'] if i['is_current']]
    
    if current_intervals:
        current = current_intervals[0]
        print("Current interval:")
        print(f"  Production: {current['production']}MW")
        print(f"  Consumption: {current['consumption']}MW")
        print(f"  Net Balance: {current['net_balance']}MW")
        print(f"  Status: {current['status']}")
        print(f"  Expected: {current['production'] - current['consumption']}MW")
        
        # Verify the fix worked
        if current['production'] < current['consumption'] and current['status'] == 'Deficit':
            print("✅ SUCCESS: Deficit status correctly shown when production < consumption")
        elif current['production'] > current['consumption'] and current['status'] == 'Surplus':
            print("✅ SUCCESS: Surplus status correctly shown when production > consumption")
        else:
            print("❌ ISSUE: Status doesn't match production vs consumption")
    else:
        print("No current interval found")
        
except Exception as e:
    print(f"Error: {e}")
