"""
Power generation data collector for Transelectrica data.
"""

import logging
from datetime import datetime, timezone
import pytz
from typing import Optional, Dict
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

from .models import PowerGenerationData, get_session
from ..api.transelectrica_client import TranselectricaClient

logger = logging.getLogger(__name__)


class PowerGenerationCollector:
    """Collector for Romanian power generation and consumption data from Transelectrica."""
    
    def __init__(self):
        self.client = TranselectricaClient()
    
    def collect_current_data(self, force_update: bool = False) -> bool:
        """
        Collect current power generation data and store in database using interval-based approach.
        Data is stored for the current 15-minute interval and updated until time moves to next interval.
        Historical data (older than 30 minutes) is preserved and never overwritten.
        
        Args:
            force_update: If True, always collect data. If False, skip if recent data exists.
            
        Returns:
            True if data was successfully collected and stored, False otherwise.
        """
        try:
            logger.info("🔄 Starting power generation data collection...")
            
            # Fetch data from Transelectrica
            power_data = self.client.fetch_power_data()
            if not power_data:
                logger.error("Failed to fetch power data from Transelectrica")
                return False
            
            # Calculate current 15-minute interval timestamp using Romanian timezone
            romanian_tz = pytz.timezone('Europe/Bucharest')
            current_time = datetime.now(romanian_tz)
            interval_timestamp = self._get_interval_timestamp(current_time)
            
            # Get database session
            session = get_session()
            
            try:
                # Check if we already have data for this exact interval
                existing_record = session.query(PowerGenerationData)\
                    .filter(PowerGenerationData.timestamp == interval_timestamp)\
                    .first()
                
                if existing_record:
                    # Check if this is a current interval (within last 30 minutes) or historical data
                    time_diff = current_time - interval_timestamp
                    time_diff_minutes = time_diff.total_seconds() / 60
                    
                    if time_diff_minutes <= 30:
                        # This is current data - safe to update
                        existing_record.nuclear = power_data['generation']['nuclear']
                        existing_record.coal = power_data['generation']['coal']
                        existing_record.gas = power_data['generation']['gas']
                        existing_record.wind = power_data['generation']['wind']
                        existing_record.hydro = power_data['generation']['hydro']
                        existing_record.solar = power_data['generation']['solar']
                        existing_record.other = power_data['generation']['other']
                        existing_record.total_production = power_data['totals']['production']
                        existing_record.total_consumption = power_data['totals']['consumption']
                        existing_record.net_balance = power_data['totals']['net_balance']
                        existing_record.interconnection_hungary = power_data['interconnections']['interconnection_hungary']
                        existing_record.interconnection_bulgaria = power_data['interconnections']['interconnection_bulgaria']
                        existing_record.interconnection_serbia = power_data['interconnections']['interconnection_serbia']
                        
                        # Update import/export units
                        existing_record.unit_muka = power_data['import_export_units']['unit_muka']
                        existing_record.unit_ispoz = power_data['import_export_units']['unit_ispoz']
                        existing_record.unit_is = power_data['import_export_units']['unit_is']
                        existing_record.unit_unge = power_data['import_export_units']['unit_unge']
                        existing_record.unit_cioa = power_data['import_export_units']['unit_cioa']
                        existing_record.unit_gote = power_data['import_export_units']['unit_gote']
                        existing_record.unit_vulc = power_data['import_export_units']['unit_vulc']
                        existing_record.unit_dobr = power_data['import_export_units']['unit_dobr']
                        existing_record.unit_varn = power_data['import_export_units']['unit_varn']
                        existing_record.unit_kozl1 = power_data['import_export_units']['unit_kozl1']
                        existing_record.unit_kozl2 = power_data['import_export_units']['unit_kozl2']
                        existing_record.unit_djer = power_data['import_export_units']['unit_djer']
                        existing_record.unit_sip = power_data['import_export_units']['unit_sip']
                        existing_record.unit_pancevo21 = power_data['import_export_units']['unit_pancevo21']
                        existing_record.unit_pancevo22 = power_data['import_export_units']['unit_pancevo22']
                        existing_record.unit_kiki = power_data['import_export_units']['unit_kiki']
                        existing_record.unit_sand = power_data['import_export_units']['unit_sand']
                        existing_record.unit_beke1 = power_data['import_export_units']['unit_beke1']
                        existing_record.unit_beke115 = power_data['import_export_units']['unit_beke115']
                        existing_record.total_import_export_units = power_data['total_import_export_units']
                        
                        # Update separate imports and exports totals
                        existing_record.imports = power_data['totals']['imports']
                        existing_record.exports = power_data['totals']['exports']
                        
                        existing_record.raw_data = power_data['raw_data']
                        
                        logger.info(f"🔄 Updated current interval data for {interval_timestamp} (age: {time_diff_minutes:.1f} minutes)")
                    else:
                        # This is historical data - preserve it, don't update
                        logger.warning(f"🔒 Preserving historical data for {interval_timestamp} (age: {time_diff_minutes:.1f} minutes) - skipping update")
                        session.commit()  # Commit to close transaction cleanly
                        return True  # Return success but indicate no update was made
                else:
                    # Create new record for this interval
                    record = PowerGenerationData(
                        timestamp=interval_timestamp,  # Use interval timestamp, not actual collection time
                        
                        # Generation by source
                        nuclear=power_data['generation']['nuclear'],
                        coal=power_data['generation']['coal'],
                        gas=power_data['generation']['gas'],
                        wind=power_data['generation']['wind'],
                        hydro=power_data['generation']['hydro'],
                        solar=power_data['generation']['solar'],
                        other=power_data['generation']['other'],
                        
                        # Totals
                        total_production=power_data['totals']['production'],
                        total_consumption=power_data['totals']['consumption'],
                        net_balance=power_data['totals']['net_balance'],
                        
                        # Interconnections
                        interconnection_hungary=power_data['interconnections']['interconnection_hungary'],
                        interconnection_bulgaria=power_data['interconnections']['interconnection_bulgaria'],
                        interconnection_serbia=power_data['interconnections']['interconnection_serbia'],
                        
                        # Specific import/export units
                        unit_muka=power_data['import_export_units']['unit_muka'],
                        unit_ispoz=power_data['import_export_units']['unit_ispoz'],
                        unit_is=power_data['import_export_units']['unit_is'],
                        unit_unge=power_data['import_export_units']['unit_unge'],
                        unit_cioa=power_data['import_export_units']['unit_cioa'],
                        unit_gote=power_data['import_export_units']['unit_gote'],
                        unit_vulc=power_data['import_export_units']['unit_vulc'],
                        unit_dobr=power_data['import_export_units']['unit_dobr'],
                        unit_varn=power_data['import_export_units']['unit_varn'],
                        unit_kozl1=power_data['import_export_units']['unit_kozl1'],
                        unit_kozl2=power_data['import_export_units']['unit_kozl2'],
                        unit_djer=power_data['import_export_units']['unit_djer'],
                        unit_sip=power_data['import_export_units']['unit_sip'],
                        unit_pancevo21=power_data['import_export_units']['unit_pancevo21'],
                        unit_pancevo22=power_data['import_export_units']['unit_pancevo22'],
                        unit_kiki=power_data['import_export_units']['unit_kiki'],
                        unit_sand=power_data['import_export_units']['unit_sand'],
                        unit_beke1=power_data['import_export_units']['unit_beke1'],
                        unit_beke115=power_data['import_export_units']['unit_beke115'],
                        
                        # Total for import/export units
                        total_import_export_units=power_data['total_import_export_units'],
                        
                        # Separate imports and exports totals
                        imports=power_data['totals']['imports'],
                        exports=power_data['totals']['exports'],
                        
                        # Metadata
                        raw_data=power_data['raw_data']
                    )
                    
                    session.add(record)
                    logger.info(f"📊 Created new interval data for {interval_timestamp}")
                
                # Commit changes
                session.commit()
                
                logger.info(f"✅ Successfully stored power generation data for interval {interval_timestamp}: {power_data['totals']['production']:.0f}MW production, {power_data['totals']['consumption']:.0f}MW consumption")
                return True
                
            except SQLAlchemyError as e:
                session.rollback()
                logger.error(f"Database error storing power generation data: {e}")
                return False
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Unexpected error in power generation data collection: {e}")
            return False
    
    def _get_interval_timestamp(self, dt: datetime) -> datetime:
        """
        Convert a datetime to its corresponding 15-minute interval timestamp.
        
        Args:
            dt: Input datetime (should be timezone-aware)
            
        Returns:
            Datetime rounded down to the nearest 15-minute interval, preserving timezone
        """
        # Round down to nearest 15-minute interval
        minutes = (dt.minute // 15) * 15
        return dt.replace(minute=minutes, second=0, microsecond=0)
    
    def get_latest_data(self) -> Optional[Dict]:
        """
        Get the latest power generation data from database with aggressive cache-busting.
        
        Returns:
            Dict with latest power data or None if no data available.
        """
        try:
            # Create a completely fresh session to avoid any caching issues
            from .models import create_database_engine
            from sqlalchemy.orm import sessionmaker
            
            # Create a new engine and session factory to ensure we get fresh data
            engine = create_database_engine()
            SessionLocal = sessionmaker(bind=engine)
            session = SessionLocal()
            
            try:
                # Force the session to not use any cached data
                session.expire_all()
                
                # Use a raw SQL query to bypass any ORM-level caching
                # Order by timestamp DESC to get the most recent record (latest timestamp)
                from sqlalchemy import text
                result = session.execute(text("""
                    SELECT * FROM power_generation_data 
                    ORDER BY timestamp DESC 
                    LIMIT 1
                """)).fetchone()
                
                if not result:
                    logger.warning("No power generation data found in database")
                    return None
                
                # Convert raw result to dict - need to handle the actual column structure
                # SQLite returns a Row object that can be accessed by column name
                data = dict(result._mapping)
                
                logger.info(f"🔍 Retrieved latest data: timestamp={data['timestamp']}, production={data['total_production']}, consumption={data['total_consumption']}, imports={data.get('imports', 0)}, exports={data.get('exports', 0)}")
                
                return {
                    'timestamp': data['timestamp'],
                    'generation': {
                        'nuclear': data['nuclear'],
                        'coal': data['coal'],
                        'gas': data['gas'],
                        'wind': data['wind'],
                        'hydro': data['hydro'],
                        'solar': data['solar'],
                        'other': data['other']
                    },
                    'totals': {
                        'production': data['total_production'],
                        'consumption': data['total_consumption'],
                        'net_balance': data['net_balance'],
                        'imports': data.get('imports', 0.0),
                        'exports': data.get('exports', 0.0)
                    },
                    'interconnections': {
                        'hungary': data['interconnection_hungary'],
                        'bulgaria': data['interconnection_bulgaria'],
                        'serbia': data['interconnection_serbia']
                    },
                    'import_export_units': {
                        'unit_muka': data.get('unit_muka', 0.0),
                        'unit_ispoz': data.get('unit_ispoz', 0.0),
                        'unit_is': data.get('unit_is', 0.0),
                        'unit_unge': data.get('unit_unge', 0.0),
                        'unit_cioa': data.get('unit_cioa', 0.0),
                        'unit_gote': data.get('unit_gote', 0.0),
                        'unit_vulc': data.get('unit_vulc', 0.0),
                        'unit_dobr': data.get('unit_dobr', 0.0),
                        'unit_varn': data.get('unit_varn', 0.0),
                        'unit_kozl1': data.get('unit_kozl1', 0.0),
                        'unit_kozl2': data.get('unit_kozl2', 0.0),
                        'unit_djer': data.get('unit_djer', 0.0),
                        'unit_sip': data.get('unit_sip', 0.0),
                        'unit_pancevo21': data.get('unit_pancevo21', 0.0),
                        'unit_pancevo22': data.get('unit_pancevo22', 0.0),
                        'unit_kiki': data.get('unit_kiki', 0.0),
                        'unit_sand': data.get('unit_sand', 0.0),
                        'unit_beke1': data.get('unit_beke1', 0.0),
                        'unit_beke115': data.get('unit_beke115', 0.0)
                    },
                    'total_import_export_units': data.get('total_import_export_units', 0.0),
                    'imports_total': data.get('imports', 0.0),
                    'exports_total': data.get('exports', 0.0)
                }
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error retrieving latest power generation data: {e}")
            return None
    
    def get_interval_data(self, start_date: datetime, end_date: datetime) -> Dict[datetime, Dict]:
        """
        Get power generation data for specific date range, organized by 15-minute intervals.
        Always returns the most recent record for each timestamp when duplicates exist.
        
        Args:
            start_date: Start of date range
            end_date: End of date range
            
        Returns:
            Dict mapping interval timestamps to power data
        """
        try:
            session = get_session()
            
            try:
                # Use a subquery to get the maximum ID for each timestamp (most recent record)
                from sqlalchemy import func
                subquery = session.query(
                    PowerGenerationData.timestamp,
                    func.max(PowerGenerationData.id).label('max_id')
                ).filter(
                    PowerGenerationData.timestamp >= start_date,
                    PowerGenerationData.timestamp < end_date
                ).group_by(PowerGenerationData.timestamp).subquery()
                
                # Join with the main table to get the full records for the most recent IDs
                records = session.query(PowerGenerationData)\
                    .join(subquery, 
                          (PowerGenerationData.timestamp == subquery.c.timestamp) & 
                          (PowerGenerationData.id == subquery.c.max_id))\
                    .order_by(PowerGenerationData.timestamp)\
                    .all()
                
                interval_data = {}
                for record in records:
                    interval_data[record.timestamp] = {
                        'timestamp': record.timestamp,
                        'generation': {
                            'nuclear': record.nuclear,
                            'coal': record.coal,
                            'gas': record.gas,
                            'wind': record.wind,
                            'hydro': record.hydro,
                            'solar': record.solar,
                            'other': record.other
                        },
                        'totals': {
                            'production': record.total_production,
                            'consumption': record.total_consumption,
                            'net_balance': record.net_balance
                        },
                        'interconnections': {
                            'hungary': record.interconnection_hungary,
                            'bulgaria': record.interconnection_bulgaria,
                            'serbia': record.interconnection_serbia
                        }
                    }
                
                return interval_data
                
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error retrieving interval power generation data: {e}")
            return {}
    
    def get_generation_mix_percentage(self) -> Optional[Dict[str, float]]:
        """
        Get the current generation mix as percentages.
        
        Returns:
            Dict with generation source percentages or None if no data available.
        """
        latest_data = self.get_latest_data()
        if not latest_data:
            return None
        
        total_production = latest_data['totals']['production']
        if total_production <= 0:
            return None
        
        generation_mix = {}
        for source, value in latest_data['generation'].items():
            if value > 0:
                percentage = (value / total_production) * 100
                generation_mix[source] = round(percentage, 1)
        
        return generation_mix
    
    def test_connection(self) -> bool:
        """Test connection to Transelectrica API."""
        return self.client.test_connection()


if __name__ == "__main__":
    # Test the collector
    logging.basicConfig(level=logging.INFO)
    
    collector = PowerGenerationCollector()
    
    print("🔧 Testing Power Generation Collector...")
    
    # Test connection
    if collector.test_connection():
        print("✅ Connection test passed")
    else:
        print("❌ Connection test failed")
        exit(1)
    
    # Test data collection
    print("📊 Collecting power generation data...")
    if collector.collect_current_data(force_update=True):
        print("✅ Data collection successful")
        
        # Get latest data
        latest = collector.get_latest_data()
        if latest:
            print(f"📈 Latest data timestamp: {latest['timestamp']}")
            print(f"⚡ Production: {latest['totals']['production']:.0f} MW")
            print(f"🏠 Consumption: {latest['totals']['consumption']:.0f} MW")
            
            # Show generation mix
            mix = collector.get_generation_mix_percentage()
            if mix:
                print("\n🏭 Generation Mix:")
                for source, percentage in sorted(mix.items(), key=lambda x: x[1], reverse=True):
                    print(f"  {source.capitalize()}: {percentage}%")
        
        print("\n🎉 Test completed successfully!")
    else:
        print("❌ Data collection failed")
        exit(1)
