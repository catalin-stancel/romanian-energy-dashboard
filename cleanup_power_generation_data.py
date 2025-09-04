#!/usr/bin/env python3
"""
Script to clean up power generation data, keeping only the 17:30 interval from today.
"""

import sqlite3
import sys
from datetime import datetime

def main():
    db_path = 'data/balancing_market.db'
    
    try:
        # Connect to database
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        print("🔍 Analyzing power generation data...")
        
        # Get total record count
        cursor.execute("SELECT COUNT(*) FROM power_generation_data")
        total_records = cursor.fetchone()[0]
        print(f"📊 Total records in database: {total_records}")
        
        # Find today's 17:30 record
        target_timestamp = '2025-08-19 17:30:00'
        cursor.execute("""
            SELECT timestamp, total_production, total_consumption, imports, exports, net_balance
            FROM power_generation_data 
            WHERE timestamp LIKE '2025-08-19 17:30:%'
            ORDER BY timestamp DESC
            LIMIT 1
        """)
        
        target_record = cursor.fetchone()
        
        if target_record:
            print(f"\n✅ Found target 17:30 interval record:")
            print(f"   Timestamp: {target_record[0]}")
            print(f"   Production: {target_record[1]} MW")
            print(f"   Consumption: {target_record[2]} MW")
            print(f"   Imports: {target_record[3]} MW")
            print(f"   Exports: {target_record[4]} MW")
            print(f"   Net Balance: {target_record[5]} MW")
            
            # Verify this record has valid import/export data (not zero)
            if target_record[3] > 0 or target_record[4] > 0:
                print("✅ Record has valid import/export data")
            else:
                print("⚠️  WARNING: Record has zero import/export values")
            
            # Ask for confirmation
            print(f"\n🗑️  This will DELETE {total_records - 1} records and keep only the 17:30 interval.")
            response = input("Are you sure you want to proceed? (yes/no): ").lower().strip()
            
            if response == 'yes':
                print("\n🔄 Executing cleanup...")
                
                # Delete all records except the target 17:30 record
                cursor.execute("""
                    DELETE FROM power_generation_data 
                    WHERE timestamp NOT LIKE '2025-08-19 17:30:%'
                """)
                
                deleted_count = cursor.rowcount
                conn.commit()
                
                print(f"✅ Cleanup completed!")
                print(f"   Deleted records: {deleted_count}")
                
                # Verify final state
                cursor.execute("SELECT COUNT(*) FROM power_generation_data")
                remaining_records = cursor.fetchone()[0]
                print(f"   Remaining records: {remaining_records}")
                
                if remaining_records == 1:
                    print("🎉 Success! Only the 17:30 interval remains in the database.")
                else:
                    print(f"⚠️  Warning: Expected 1 record, but {remaining_records} remain.")
                
            else:
                print("❌ Operation cancelled by user.")
                
        else:
            print("❌ ERROR: Could not find today's 17:30 interval record!")
            print("Available records for today:")
            cursor.execute("""
                SELECT timestamp, total_production, total_consumption, imports, exports
                FROM power_generation_data 
                WHERE DATE(timestamp) = '2025-08-19'
                ORDER BY timestamp
            """)
            
            today_records = cursor.fetchall()
            for record in today_records:
                print(f"   {record[0]} - Prod: {record[1]}, Cons: {record[2]}, Imp: {record[3]}, Exp: {record[4]}")
        
    except sqlite3.Error as e:
        print(f"❌ Database error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        sys.exit(1)
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    main()
