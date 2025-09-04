"""
Interval transition collector for preserving final interval data.
Ensures that when intervals change, the final data from the previous interval is preserved.
"""

import logging
from datetime import datetime, timedelta
import pytz
from typing import Optional, Dict
from sqlalchemy.orm import Session
from sqlalchemy.exc import SQLAlchemyError

from .models import PowerGenerationData, get_session
from ..api.transelectrica_client import TranselectricaClient

logger = logging.getLogger(__name__)


class IntervalTransitionCollector:
    """Collector that handles interval transitions properly."""
    
    def __init__(self):
        self.client = TranselectricaClient()
        self.last_interval_timestamp = None
        self.last_interval_data = None
        self.romanian_tz = pytz.timezone('Europe/Bucharest')
    
    def collect_with_transition_handling(self, force_update: bool = False) -> bool:
        """
        Collect data with proper interval transition handling.
        When interval changes, take current live data and save it for the previous interval.
        
        Args:
            force_update: If True, always collect data
            
        Returns:
            True if data was successfully collected and stored, False otherwise
        """
        try:
            logger.info("🔄 Starting interval-aware data collection...")
            
            # Get current time and interval
            current_time = datetime.now(self.romanian_tz)
            current_interval = self._get_interval_timestamp(current_time)
            
            # Fetch fresh data from API first
            power_data = self.client.fetch_power_data()
            if not power_data:
                logger.error("Failed to fetch power data from Transelectrica")
                return False
            
            # Check if we've moved to a new interval
            if self.last_interval_timestamp and current_interval != self.last_interval_timestamp:
                logger.info(f"🔄 Interval transition detected: {self.last_interval_timestamp} → {current_interval}")
                
                # Take the CURRENT live data and save it as the final data for the PREVIOUS interval
                # This ensures the previous interval gets the last real data that was available
                logger.info(f"💾 Saving current live data as final data for previous interval {self.last_interval_timestamp}")
                self._save_final_interval_data(self.last_interval_timestamp, power_data)
            
            # Update our tracking variables
            self.last_interval_timestamp = current_interval
            self.last_interval_data = power_data
            
            # Save/update data for current interval
            success = self._save_current_interval_data(current_interval, power_data)
            
            if success:
                logger.info(f"✅ Successfully collected data for interval {current_interval}")
            
            return success
            
        except Exception as e:
            logger.error(f"Unexpected error in interval-aware data collection: {e}")
            return False
    
    def _save_final_interval_data(self, interval_timestamp: datetime, power_data: Dict) -> bool:
        """
        Save the final data for a completed interval.
        This ensures historical accuracy by preserving the last known state.
        """
        try:
            logger.info(f"💾 Saving final data for completed interval {interval_timestamp}")
            
            session = get_session()
            
            try:
                # Check if record exists for this interval
                existing_record = session.query(PowerGenerationData)\
                    .filter(PowerGenerationData.timestamp == interval_timestamp)\
                    .first()
                
                if existing_record:
                    # Update with final data
                    self._update_record_with_data(existing_record, power_data)
                    logger.info(f"📝 Updated final data for interval {interval_timestamp}")
                else:
                    # Create new record with final data
                    record = self._create_record_from_data(interval_timestamp, power_data)
                    session.add(record)
                    logger.info(f"📊 Created final record for interval {interval_timestamp}")
                
                session.commit()
                return True
                
            except SQLAlchemyError as e:
                session.rollback()
                logger.error(f"Database error saving final interval data: {e}")
                return False
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error saving final interval data: {e}")
            return False
    
    def _save_current_interval_data(self, interval_timestamp: datetime, power_data: Dict) -> bool:
        """
        Save/update data for the current interval.
        This can be called multiple times during an interval.
        """
        try:
            session = get_session()
            
            try:
                # Check if record exists for this interval
                existing_record = session.query(PowerGenerationData)\
                    .filter(PowerGenerationData.timestamp == interval_timestamp)\
                    .first()
                
                if existing_record:
                    # Check if this is current data (within last 30 minutes)
                    current_time = datetime.now(self.romanian_tz)
                    time_diff = current_time - interval_timestamp
                    time_diff_minutes = time_diff.total_seconds() / 60
                    
                    if time_diff_minutes <= 30:
                        # Update current interval data
                        self._update_record_with_data(existing_record, power_data)
                        logger.debug(f"🔄 Updated current interval data for {interval_timestamp}")
                    else:
                        # This is historical data - preserve it
                        logger.warning(f"🔒 Preserving historical data for {interval_timestamp}")
                        session.commit()
                        return True
                else:
                    # Create new record
                    record = self._create_record_from_data(interval_timestamp, power_data)
                    session.add(record)
                    logger.info(f"📊 Created new record for interval {interval_timestamp}")
                
                session.commit()
                return True
                
            except SQLAlchemyError as e:
                session.rollback()
                logger.error(f"Database error saving current interval data: {e}")
                return False
            finally:
                session.close()
                
        except Exception as e:
            logger.error(f"Error saving current interval data: {e}")
            return False
    
    def _update_record_with_data(self, record: PowerGenerationData, power_data: Dict):
        """Update a database record with power data."""
        # Generation by source
        record.nuclear = power_data['generation']['nuclear']
        record.coal = power_data['generation']['coal']
        record.gas = power_data['generation']['gas']
        record.wind = power_data['generation']['wind']
        record.hydro = power_data['generation']['hydro']
        record.solar = power_data['generation']['solar']
        record.other = power_data['generation']['other']
        
        # Totals
        record.total_production = power_data['totals']['production']
        record.total_consumption = power_data['totals']['consumption']
        record.net_balance = power_data['totals']['net_balance']
        
        # Interconnections
        record.interconnection_hungary = power_data['interconnections']['interconnection_hungary']
        record.interconnection_bulgaria = power_data['interconnections']['interconnection_bulgaria']
        record.interconnection_serbia = power_data['interconnections']['interconnection_serbia']
        
        # Import/export units
        record.unit_muka = power_data['import_export_units']['unit_muka']
        record.unit_ispoz = power_data['import_export_units']['unit_ispoz']
        record.unit_is = power_data['import_export_units']['unit_is']
        record.unit_unge = power_data['import_export_units']['unit_unge']
        record.unit_cioa = power_data['import_export_units']['unit_cioa']
        record.unit_gote = power_data['import_export_units']['unit_gote']
        record.unit_vulc = power_data['import_export_units']['unit_vulc']
        record.unit_dobr = power_data['import_export_units']['unit_dobr']
        record.unit_varn = power_data['import_export_units']['unit_varn']
        record.unit_kozl1 = power_data['import_export_units']['unit_kozl1']
        record.unit_kozl2 = power_data['import_export_units']['unit_kozl2']
        record.unit_djer = power_data['import_export_units']['unit_djer']
        record.unit_sip = power_data['import_export_units']['unit_sip']
        record.unit_pancevo21 = power_data['import_export_units']['unit_pancevo21']
        record.unit_pancevo22 = power_data['import_export_units']['unit_pancevo22']
        record.unit_kiki = power_data['import_export_units']['unit_kiki']
        record.unit_sand = power_data['import_export_units']['unit_sand']
        record.unit_beke1 = power_data['import_export_units']['unit_beke1']
        record.unit_beke115 = power_data['import_export_units']['unit_beke115']
        record.total_import_export_units = power_data['total_import_export_units']
        
        # Separate imports and exports totals
        record.imports = power_data['totals']['imports']
        record.exports = power_data['totals']['exports']
        
        # Raw data
        record.raw_data = power_data['raw_data']
    
    def _create_record_from_data(self, interval_timestamp: datetime, power_data: Dict) -> PowerGenerationData:
        """Create a new database record from power data."""
        return PowerGenerationData(
            timestamp=interval_timestamp,
            
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
            
            # Import/export units
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
            total_import_export_units=power_data['total_import_export_units'],
            
            # Separate imports and exports totals
            imports=power_data['totals']['imports'],
            exports=power_data['totals']['exports'],
            
            # Raw data
            raw_data=power_data['raw_data']
        )
    
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
        Get the latest power generation data from database.
        
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
    # Test the interval transition collector
    logging.basicConfig(level=logging.INFO)
    
    collector = IntervalTransitionCollector()
    
    print("🔧 Testing Interval Transition Collector...")
    
    # Test connection
    if collector.test_connection():
        print("✅ Connection test passed")
    else:
        print("❌ Connection test failed")
        exit(1)
    
    # Test data collection with transition handling
    print("📊 Testing interval-aware data collection...")
    if collector.collect_with_transition_handling(force_update=True):
        print("✅ Interval-aware data collection successful")
        print("\n🎉 Test completed successfully!")
    else:
        print("❌ Interval-aware data collection failed")
        exit(1)
