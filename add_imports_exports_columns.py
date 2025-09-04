"""
Script to add imports and exports columns to existing power_generation_data table.
"""

import sqlite3
from pathlib import Path

# Database path
db_path = Path("data/balancing_market.db")

if not db_path.exists():
    print(f"❌ Database not found at {db_path}")
    exit(1)

# Connect to database
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    # Check if columns already exist
    cursor.execute("PRAGMA table_info(power_generation_data)")
    columns = [row[1] for row in cursor.fetchall()]
    
    print(f"Current columns: {len(columns)}")
    
    # Add imports column if it doesn't exist
    if 'imports' not in columns:
        print("Adding 'imports' column...")
        cursor.execute("ALTER TABLE power_generation_data ADD COLUMN imports REAL DEFAULT 0.0")
        print("✅ Added 'imports' column")
    else:
        print("✅ 'imports' column already exists")
    
    # Add exports column if it doesn't exist
    if 'exports' not in columns:
        print("Adding 'exports' column...")
        cursor.execute("ALTER TABLE power_generation_data ADD COLUMN exports REAL DEFAULT 0.0")
        print("✅ Added 'exports' column")
    else:
        print("✅ 'exports' column already exists")
    
    # Commit changes
    conn.commit()
    print("✅ Database schema updated successfully")
    
    # Verify the changes
    cursor.execute("PRAGMA table_info(power_generation_data)")
    new_columns = [row[1] for row in cursor.fetchall()]
    print(f"Updated columns: {len(new_columns)}")
    
    if 'imports' in new_columns and 'exports' in new_columns:
        print("🎉 Both imports and exports columns are now present")
    else:
        print("❌ Something went wrong - columns not found")

except Exception as e:
    print(f"❌ Error updating database: {e}")
    conn.rollback()

finally:
    conn.close()
