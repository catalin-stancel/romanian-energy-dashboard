from src.data.models import ImbalancePrice, ImbalanceVolume, get_session
from datetime import datetime, timedelta
import pytz

print("=== Fixing Existing Database Timestamps ===")
print("Converting UTC timestamps to Romanian local time (UTC+3)")

with get_session() as session:
    # Fix price data timestamps
    print("\n1. Fixing Price Data Timestamps...")
    price_records = session.query(ImbalancePrice).all()
    price_count = 0
    
    for price in price_records:
        # Add 3 hours to convert from UTC to Romanian time
        old_timestamp = price.timestamp
        new_timestamp = old_timestamp + timedelta(hours=3)
        price.timestamp = new_timestamp
        price_count += 1
        
        if price_count <= 5:  # Show first 5 examples
            print(f"  {old_timestamp.strftime('%Y-%m-%d %H:%M:%S')} -> {new_timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
    
    print(f"Updated {price_count} price records")
    
    # Fix volume data timestamps
    print("\n2. Fixing Volume Data Timestamps...")
    volume_records = session.query(ImbalanceVolume).all()
    volume_count = 0
    
    for volume in volume_records:
        # Add 3 hours to convert from UTC to Romanian time
        old_timestamp = volume.timestamp
        new_timestamp = old_timestamp + timedelta(hours=3)
        volume.timestamp = new_timestamp
        volume_count += 1
        
        if volume_count <= 5:  # Show first 5 examples
            print(f"  {old_timestamp.strftime('%Y-%m-%d %H:%M:%S')} -> {new_timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
    
    print(f"Updated {volume_count} volume records")
    
    # Commit all changes
    session.commit()
    print(f"\n✅ Successfully updated {price_count + volume_count} total records")
    
    # Verify the fix by checking the 1.58 value
    price_158 = session.query(ImbalancePrice).filter(ImbalancePrice.value == 1.58).first()
    if price_158:
        print(f"\n🎯 Verification: 1.58 value is now at: {price_158.timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
        print("   This should now be 17:15 instead of 14:15!")
    
    print("\n=== Timestamp Fix Complete ===")
    print("All existing data has been converted from UTC to Romanian local time.")
    print("The dashboard should now show correct Romanian timestamps.")
