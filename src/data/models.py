"""
Database models for Romanian Energy Balancing Market data.
"""

from sqlalchemy import create_engine, Column, Integer, Float, String, DateTime, Boolean, Index
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime
import yaml
import os
from pathlib import Path
from urllib.parse import urlparse

# Load configuration based on environment
def load_config():
    """Load configuration based on environment."""
    if os.getenv('RENDER'):  # Running on Render.com
        config_path = Path(__file__).parent.parent.parent / "config.prod.yaml"
    else:
        config_path = Path(__file__).parent.parent.parent / "config.yaml"
    
    with open(config_path, 'r') as f:
        config_content = f.read()
    
    # Replace environment variables in config
    for key, value in os.environ.items():
        config_content = config_content.replace(f"${{{key}}}", value)
    
    return yaml.safe_load(config_content)

config = load_config()

Base = declarative_base()


class ImbalancePrice(Base):
    """Model for imbalance price data."""
    
    __tablename__ = 'imbalance_prices'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    value = Column(Float, nullable=False)
    business_type = Column(String(10), nullable=True)
    price_category = Column(String(10), nullable=True, index=True)
    currency = Column(String(3), nullable=True)
    measure_unit = Column(String(10), nullable=True)
    resolution_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Composite index for efficient queries
    __table_args__ = (
        Index('idx_prices_timestamp_value', 'timestamp', 'value'),
        Index('idx_prices_timestamp_category', 'timestamp', 'price_category'),
    )
    
    def __repr__(self):
        return f"<ImbalancePrice(timestamp={self.timestamp}, value={self.value}, category={self.price_category})>"


class ImbalanceVolume(Base):
    """Model for imbalance volume data."""
    
    __tablename__ = 'imbalance_volumes'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    value = Column(Float, nullable=False)
    business_type = Column(String(10), nullable=True)
    currency = Column(String(3), nullable=True)
    measure_unit = Column(String(10), nullable=True)
    resolution_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Index for efficient queries
    __table_args__ = (
        Index('idx_volumes_timestamp_value', 'timestamp', 'value'),
    )
    
    def __repr__(self):
        return f"<ImbalanceVolume(timestamp={self.timestamp}, value={self.value})>"


class EnhancedImbalanceVolume(Base):
    """Model for enhanced imbalance volume data with flow direction support."""
    
    __tablename__ = 'enhanced_imbalance_volumes'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    value = Column(Float, nullable=False)
    flow_direction = Column(String(3), nullable=False, index=True)  # A01 (import) or A02 (export)
    business_type = Column(String(10), nullable=True)
    measure_unit = Column(String(10), nullable=True)
    resolution_minutes = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Composite indexes for efficient queries
    __table_args__ = (
        Index('idx_enhanced_volumes_timestamp_flow', 'timestamp', 'flow_direction'),
        Index('idx_enhanced_volumes_timestamp_value', 'timestamp', 'value'),
    )
    
    def __repr__(self):
        return f"<EnhancedImbalanceVolume(timestamp={self.timestamp}, flow={self.flow_direction}, value={self.value})>"


class NetImbalanceVolume(Base):
    """Model for calculated net imbalance volumes and deficit/surplus status."""
    
    __tablename__ = 'net_imbalance_volumes'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    import_volume = Column(Float, nullable=False, default=0.0)  # A01 flow
    export_volume = Column(Float, nullable=False, default=0.0)  # A02 flow
    net_volume = Column(Float, nullable=False)  # import - export
    status = Column(String(10), nullable=False, index=True)  # 'Surplus', 'Deficit', 'Balanced'
    measure_unit = Column(String(10), nullable=True, default='MWH')
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Composite indexes for efficient queries
    __table_args__ = (
        Index('idx_net_volumes_timestamp_status', 'timestamp', 'status'),
        Index('idx_net_volumes_timestamp_net', 'timestamp', 'net_volume'),
    )
    
    def __repr__(self):
        return f"<NetImbalanceVolume(timestamp={self.timestamp}, net={self.net_volume}, status={self.status})>"


class DataCollectionLog(Base):
    """Model for tracking data collection activities."""
    
    __tablename__ = 'data_collection_logs'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    collection_type = Column(String(20), nullable=False)  # 'prices' or 'volumes'
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    records_collected = Column(Integer, nullable=False, default=0)
    success = Column(Boolean, nullable=False, default=False)
    error_message = Column(String(500), nullable=True)
    collection_time = Column(DateTime, default=datetime.utcnow)
    duration_seconds = Column(Float, nullable=True)
    
    def __repr__(self):
        return f"<DataCollectionLog(type={self.collection_type}, records={self.records_collected}, success={self.success})>"


class MarketStatistics(Base):
    """Model for storing calculated market statistics."""
    
    __tablename__ = 'market_statistics'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    date = Column(DateTime, nullable=False, index=True)
    statistic_type = Column(String(50), nullable=False)  # 'daily_avg', 'weekly_avg', 'volatility', etc.
    price_category = Column(String(10), nullable=True)
    value = Column(Float, nullable=False)
    extra_data = Column(String(500), nullable=True)  # JSON string for additional info
    calculated_at = Column(DateTime, default=datetime.utcnow)
    
    # Composite index for efficient queries
    __table_args__ = (
        Index('idx_date_type', 'date', 'statistic_type'),
        Index('idx_date_category', 'date', 'price_category'),
    )
    
    def __repr__(self):
        return f"<MarketStatistics(date={self.date}, type={self.statistic_type}, value={self.value})>"


class PowerGenerationData(Base):
    """Model for storing Transelectrica power generation and consumption data."""
    
    __tablename__ = 'power_generation_data'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, nullable=False, index=True)
    
    # Generation by source (MW)
    nuclear = Column(Float, nullable=True, default=0.0)
    coal = Column(Float, nullable=True, default=0.0)
    gas = Column(Float, nullable=True, default=0.0)
    wind = Column(Float, nullable=True, default=0.0)
    hydro = Column(Float, nullable=True, default=0.0)
    solar = Column(Float, nullable=True, default=0.0)
    other = Column(Float, nullable=True, default=0.0)
    
    # Total production and consumption (MW)
    total_production = Column(Float, nullable=False)
    total_consumption = Column(Float, nullable=False)
    net_balance = Column(Float, nullable=False)  # production - consumption
    
    # Grid interconnections (MW) - positive = export, negative = import
    interconnection_hungary = Column(Float, nullable=True, default=0.0)  # DOBR
    interconnection_bulgaria = Column(Float, nullable=True, default=0.0)  # VARN
    interconnection_serbia = Column(Float, nullable=True, default=0.0)    # VULC
    interconnection_ukraine = Column(Float, nullable=True, default=0.0)   # Other connections
    
    # Specific power generation units for imports/exports tracking (MW)
    unit_muka = Column(Float, nullable=True, default=0.0)
    unit_ispoz = Column(Float, nullable=True, default=0.0)
    unit_is = Column(Float, nullable=True, default=0.0)
    unit_unge = Column(Float, nullable=True, default=0.0)
    unit_cioa = Column(Float, nullable=True, default=0.0)
    unit_gote = Column(Float, nullable=True, default=0.0)
    unit_vulc = Column(Float, nullable=True, default=0.0)
    unit_dobr = Column(Float, nullable=True, default=0.0)
    unit_varn = Column(Float, nullable=True, default=0.0)
    unit_kozl1 = Column(Float, nullable=True, default=0.0)
    unit_kozl2 = Column(Float, nullable=True, default=0.0)
    unit_djer = Column(Float, nullable=True, default=0.0)
    unit_sip = Column(Float, nullable=True, default=0.0)
    unit_pancevo21 = Column(Float, nullable=True, default=0.0)
    unit_pancevo22 = Column(Float, nullable=True, default=0.0)
    unit_kiki = Column(Float, nullable=True, default=0.0)
    unit_sand = Column(Float, nullable=True, default=0.0)
    unit_beke1 = Column(Float, nullable=True, default=0.0)
    unit_beke115 = Column(Float, nullable=True, default=0.0)
    
    # Calculated totals for import/export units
    total_import_export_units = Column(Float, nullable=True, default=0.0)
    
    # Separate imports and exports totals from import/export units
    imports = Column(Float, nullable=True, default=0.0)  # Positive values from import/export units
    exports = Column(Float, nullable=True, default=0.0)  # Absolute value of negative values from import/export units
    
    # Metadata
    data_source = Column(String(50), nullable=False, default='transelectrica')
    raw_data = Column(String(2000), nullable=True)  # Store original JSON for debugging
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Composite indexes for efficient queries
    __table_args__ = (
        Index('idx_generation_timestamp', 'timestamp'),
        Index('idx_generation_production', 'timestamp', 'total_production'),
        Index('idx_generation_balance', 'timestamp', 'net_balance'),
    )
    
    def __repr__(self):
        return f"<PowerGenerationData(timestamp={self.timestamp}, production={self.total_production}, consumption={self.total_consumption})>"


class PriceForecast(Base):
    """Model for storing price forecasts."""
    
    __tablename__ = 'price_forecasts'
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    forecast_timestamp = Column(DateTime, nullable=False, index=True)
    forecast_horizon_hours = Column(Integer, nullable=False)
    model_name = Column(String(50), nullable=False)
    predicted_value = Column(Float, nullable=False)
    confidence_lower = Column(Float, nullable=True)
    confidence_upper = Column(Float, nullable=True)
    confidence_level = Column(Float, nullable=True)  # e.g., 0.95 for 95%
    actual_value = Column(Float, nullable=True)  # Filled in later for validation
    created_at = Column(DateTime, default=datetime.utcnow)
    
    # Composite index for efficient queries
    __table_args__ = (
        Index('idx_forecast_model', 'forecast_timestamp', 'model_name'),
        Index('idx_forecast_horizon', 'forecast_timestamp', 'forecast_horizon_hours'),
    )
    
    def __repr__(self):
        return f"<PriceForecast(timestamp={self.forecast_timestamp}, model={self.model_name}, value={self.predicted_value})>"


def create_database_engine():
    """Create database engine based on configuration."""
    db_config = config['database']
    
    if db_config['type'] == 'sqlite':
        # Ensure data directory exists
        db_path = Path(db_config['path'])
        db_path.parent.mkdir(parents=True, exist_ok=True)
        
        engine = create_engine(f"sqlite:///{db_config['path']}", echo=False)
    elif db_config['type'] == 'postgresql':
        # Use PostgreSQL connection URL from environment
        database_url = db_config.get('url') or os.getenv('DATABASE_URL')
        
        # Handle case where DATABASE_URL is not set or is placeholder
        if not database_url or database_url == '${DATABASE_URL}':
            # Fallback to SQLite for development/testing
            print("Warning: DATABASE_URL not found, falling back to SQLite")
            db_path = Path("data/balancing_market.db")
            db_path.parent.mkdir(parents=True, exist_ok=True)
            engine = create_engine(f"sqlite:///{db_path}", echo=False)
        else:
            # Create engine with connection pooling for production
            engine = create_engine(
                database_url,
                echo=False,
                pool_size=10,
                max_overflow=20,
                pool_pre_ping=True,
                pool_recycle=300
            )
    else:
        raise ValueError(f"Unsupported database type: {db_config['type']}")
    
    return engine


def create_tables(engine=None):
    """Create all database tables."""
    if engine is None:
        engine = create_database_engine()
    
    Base.metadata.create_all(engine)
    return engine


def get_session(engine=None):
    """Get database session."""
    if engine is None:
        engine = create_database_engine()
    
    Session = sessionmaker(bind=engine)
    return Session()


if __name__ == "__main__":
    # Create database and tables
    print("Creating database and tables...")
    engine = create_tables()
    
    # Print appropriate success message based on database type
    if 'path' in config['database']:
        print(f"✅ Database created at: {config['database']['path']}")
    else:
        print("✅ Database configured successfully")
    
    # Test session creation
    session = get_session(engine)
    print("✅ Database session created successfully")
    session.close()
    
    print("🎉 Database setup completed!")
