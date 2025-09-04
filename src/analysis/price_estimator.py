"""
Price estimation algorithms for Romanian energy balancing market.
Implements various forecasting models and market analysis tools.
"""

import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import logging
from sqlalchemy.orm import Session
from sqlalchemy import and_, func

import sys
import os
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from src.data.models import (
    ImbalancePrice, ImbalanceVolume, MarketStatistics, PriceForecast,
    get_session
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class PriceEstimator:
    """Advanced price estimation and forecasting for energy balancing market."""
    
    def __init__(self):
        """Initialize the price estimator with various models."""
        self.models = {
            'linear': LinearRegression(),
            'random_forest': RandomForestRegressor(n_estimators=100, random_state=42),
            'gradient_boost': GradientBoostingRegressor(n_estimators=100, random_state=42)
        }
        self.scaler = StandardScaler()
        self.is_trained = False
        self.feature_columns = []
        
        logger.info("Initialized PriceEstimator with multiple models")
    
    def load_historical_data(self, days_back: int = 30) -> pd.DataFrame:
        """
        Load historical price and volume data for analysis.
        
        Args:
            days_back: Number of days of historical data to load
            
        Returns:
            DataFrame with combined price and volume data
        """
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days_back)
        
        with get_session() as session:
            # Load price data
            price_query = session.query(ImbalancePrice).filter(
                and_(
                    ImbalancePrice.timestamp >= start_date,
                    ImbalancePrice.timestamp <= end_date
                )
            ).order_by(ImbalancePrice.timestamp)
            
            price_data = pd.read_sql(price_query.statement, session.bind)
            
            # Load volume data
            volume_query = session.query(ImbalanceVolume).filter(
                and_(
                    ImbalanceVolume.timestamp >= start_date,
                    ImbalanceVolume.timestamp <= end_date
                )
            ).order_by(ImbalanceVolume.timestamp)
            
            volume_data = pd.read_sql(volume_query.statement, session.bind)
        
        # Merge price and volume data
        if not price_data.empty and not volume_data.empty:
            combined_data = pd.merge(
                price_data, volume_data, 
                on='timestamp', 
                how='outer', 
                suffixes=('_price', '_volume')
            )
        elif not price_data.empty:
            combined_data = price_data.copy()
            combined_data['value_volume'] = np.nan
        elif not volume_data.empty:
            combined_data = volume_data.copy()
            combined_data['value_price'] = np.nan
        else:
            combined_data = pd.DataFrame()
        
        if not combined_data.empty:
            combined_data['timestamp'] = pd.to_datetime(combined_data['timestamp'])
            combined_data = combined_data.sort_values('timestamp').reset_index(drop=True)
        
        logger.info(f"Loaded {len(combined_data)} records of historical data")
        return combined_data
    
    def create_features(self, data: pd.DataFrame) -> pd.DataFrame:
        """
        Create features for price prediction models.
        
        Args:
            data: Historical market data
            
        Returns:
            DataFrame with engineered features
        """
        if data.empty:
            return data
        
        df = data.copy()
        df['timestamp'] = pd.to_datetime(df['timestamp'])
        df = df.set_index('timestamp').sort_index()
        
        # Time-based features
        df['hour'] = df.index.hour
        df['day_of_week'] = df.index.dayofweek
        df['month'] = df.index.month
        df['is_weekend'] = (df.index.dayofweek >= 5).astype(int)
        
        # Peak hours (typically 8-20)
        df['is_peak_hour'] = ((df.index.hour >= 8) & (df.index.hour <= 20)).astype(int)
        
        # Lagged features for price
        if 'value_price' in df.columns:
            df['price_lag_1h'] = df['value_price'].shift(4)  # 4 periods = 1 hour (15min intervals)
            df['price_lag_3h'] = df['value_price'].shift(12)
            df['price_lag_24h'] = df['value_price'].shift(96)  # 24 hours
            
            # Rolling statistics for price
            df['price_ma_4h'] = df['value_price'].rolling(window=16, min_periods=1).mean()
            df['price_ma_24h'] = df['value_price'].rolling(window=96, min_periods=1).mean()
            df['price_std_4h'] = df['value_price'].rolling(window=16, min_periods=1).std()
            df['price_volatility'] = df['price_std_4h'] / df['price_ma_4h']
        
        # Lagged features for volume
        if 'value_volume' in df.columns:
            df['volume_lag_1h'] = df['value_volume'].shift(4)
            df['volume_lag_3h'] = df['value_volume'].shift(12)
            df['volume_lag_24h'] = df['value_volume'].shift(96)
            
            # Rolling statistics for volume
            df['volume_ma_4h'] = df['value_volume'].rolling(window=16, min_periods=1).mean()
            df['volume_ma_24h'] = df['value_volume'].rolling(window=96, min_periods=1).mean()
            df['volume_std_4h'] = df['value_volume'].rolling(window=16, min_periods=1).std()
        
        # Price-volume interaction features
        if 'value_price' in df.columns and 'value_volume' in df.columns:
            df['price_volume_ratio'] = df['value_price'] / (df['value_volume'] + 1e-6)
            df['price_volume_product'] = df['value_price'] * df['value_volume']
        
        # Reset index to make timestamp a column again
        df = df.reset_index()
        
        # Define feature columns (exclude target and metadata columns)
        exclude_cols = ['timestamp', 'value_price', 'id_price', 'id_volume', 
                       'created_at_price', 'updated_at_price', 'created_at_volume', 'updated_at_volume']
        self.feature_columns = [col for col in df.columns if col not in exclude_cols]
        
        logger.info(f"Created {len(self.feature_columns)} features for modeling")
        return df
    
    def train_models(self, data: pd.DataFrame, target_column: str = 'value_price') -> Dict[str, Dict[str, float]]:
        """
        Train all prediction models on historical data.
        
        Args:
            data: Training data with features
            target_column: Column name for target variable
            
        Returns:
            Dictionary with model performance metrics
        """
        if data.empty or target_column not in data.columns:
            logger.warning("No training data available")
            return {}
        
        # Prepare training data
        feature_data = data[self.feature_columns].copy()
        target_data = data[target_column].copy()
        
        # Remove rows with missing target values
        valid_mask = ~target_data.isna()
        feature_data = feature_data[valid_mask]
        target_data = target_data[valid_mask]
        
        if len(feature_data) < 10:
            logger.warning("Insufficient training data")
            return {}
        
        # Fill missing feature values
        feature_data = feature_data.fillna(feature_data.mean())
        
        # Scale features
        feature_data_scaled = self.scaler.fit_transform(feature_data)
        
        # Split data for validation (80/20 split)
        split_idx = int(0.8 * len(feature_data))
        X_train, X_val = feature_data_scaled[:split_idx], feature_data_scaled[split_idx:]
        y_train, y_val = target_data.iloc[:split_idx], target_data.iloc[split_idx:]
        
        model_performance = {}
        
        # Train each model
        for model_name, model in self.models.items():
            try:
                logger.info(f"Training {model_name} model...")
                
                # Train model
                model.fit(X_train, y_train)
                
                # Make predictions on validation set
                y_pred = model.predict(X_val)
                
                # Calculate metrics
                mae = mean_absolute_error(y_val, y_pred)
                mse = mean_squared_error(y_val, y_pred)
                rmse = np.sqrt(mse)
                r2 = r2_score(y_val, y_pred)
                
                model_performance[model_name] = {
                    'mae': mae,
                    'mse': mse,
                    'rmse': rmse,
                    'r2': r2,
                    'training_samples': len(X_train),
                    'validation_samples': len(X_val)
                }
                
                logger.info(f"{model_name} - MAE: {mae:.2f}, RMSE: {rmse:.2f}, R²: {r2:.3f}")
                
            except Exception as e:
                logger.error(f"Error training {model_name}: {str(e)}")
                continue
        
        self.is_trained = len(model_performance) > 0
        logger.info(f"Successfully trained {len(model_performance)} models")
        
        return model_performance
    
    def predict_prices(self, 
                      forecast_hours: int = 24, 
                      model_name: str = 'random_forest') -> pd.DataFrame:
        """
        Generate price forecasts for the specified time horizon.
        
        Args:
            forecast_hours: Number of hours to forecast
            model_name: Name of the model to use for prediction
            
        Returns:
            DataFrame with price forecasts
        """
        if not self.is_trained:
            logger.error("Models not trained. Call train_models() first.")
            return pd.DataFrame()
        
        if model_name not in self.models:
            logger.error(f"Model {model_name} not available")
            return pd.DataFrame()
        
        # Load recent data for feature creation
        recent_data = self.load_historical_data(days_back=7)
        if recent_data.empty:
            logger.error("No recent data available for forecasting")
            return pd.DataFrame()
        
        # Create features
        feature_data = self.create_features(recent_data)
        
        # Generate forecast timestamps
        last_timestamp = feature_data['timestamp'].max()
        forecast_timestamps = pd.date_range(
            start=last_timestamp + timedelta(minutes=15),
            periods=forecast_hours * 4,  # 4 periods per hour (15-min intervals)
            freq='15T'
        )
        
        forecasts = []
        model = self.models[model_name]
        
        for timestamp in forecast_timestamps:
            try:
                # Create features for this timestamp
                # For simplicity, use the last available features
                # In a production system, you'd want more sophisticated feature engineering
                last_features = feature_data[self.feature_columns].iloc[-1:].copy()
                
                # Update time-based features
                last_features['hour'] = timestamp.hour
                last_features['day_of_week'] = timestamp.dayofweek
                last_features['month'] = timestamp.month
                last_features['is_weekend'] = int(timestamp.dayofweek >= 5)
                last_features['is_peak_hour'] = int(8 <= timestamp.hour <= 20)
                
                # Fill missing values
                last_features = last_features.fillna(last_features.mean())
                
                # Scale features
                features_scaled = self.scaler.transform(last_features)
                
                # Make prediction
                prediction = model.predict(features_scaled)[0]
                
                forecasts.append({
                    'timestamp': timestamp,
                    'predicted_price': prediction,
                    'model': model_name
                })
                
            except Exception as e:
                logger.error(f"Error predicting for {timestamp}: {str(e)}")
                continue
        
        forecast_df = pd.DataFrame(forecasts)
        logger.info(f"Generated {len(forecast_df)} price forecasts using {model_name}")
        
        return forecast_df
    
    def calculate_market_statistics(self, days_back: int = 30) -> Dict[str, Any]:
        """
        Calculate comprehensive market statistics.
        
        Args:
            days_back: Number of days to analyze
            
        Returns:
            Dictionary with market statistics
        """
        data = self.load_historical_data(days_back)
        
        if data.empty:
            return {}
        
        stats = {}
        
        # Price statistics
        if 'value_price' in data.columns and not data['value_price'].isna().all():
            price_data = data['value_price'].dropna()
            stats['price_stats'] = {
                'mean': float(price_data.mean()),
                'median': float(price_data.median()),
                'std': float(price_data.std()),
                'min': float(price_data.min()),
                'max': float(price_data.max()),
                'count': int(len(price_data))
            }
        
        # Volume statistics
        if 'value_volume' in data.columns and not data['value_volume'].isna().all():
            volume_data = data['value_volume'].dropna()
            stats['volume_stats'] = {
                'mean': float(volume_data.mean()),
                'median': float(volume_data.median()),
                'std': float(volume_data.std()),
                'min': float(volume_data.min()),
                'max': float(volume_data.max()),
                'count': int(len(volume_data))
            }
        
        # Time-based analysis
        if 'timestamp' in data.columns:
            data['timestamp'] = pd.to_datetime(data['timestamp'])
            data['hour'] = data['timestamp'].dt.hour
            
            if 'value_price' in data.columns:
                hourly_prices = data.groupby('hour')['value_price'].mean().to_dict()
                stats['hourly_price_patterns'] = {str(k): float(v) for k, v in hourly_prices.items() if not pd.isna(v)}
            
            if 'value_volume' in data.columns:
                hourly_volumes = data.groupby('hour')['value_volume'].mean().to_dict()
                stats['hourly_volume_patterns'] = {str(k): float(v) for k, v in hourly_volumes.items() if not pd.isna(v)}
        
        logger.info("Calculated comprehensive market statistics")
        return stats
    
    def save_forecast_to_db(self, forecasts: pd.DataFrame, model_name: str):
        """
        Save price forecasts to the database.
        
        Args:
            forecasts: DataFrame with forecast data
            model_name: Name of the model used
        """
        if forecasts.empty:
            return
        
        with get_session() as session:
            for _, row in forecasts.iterrows():
                forecast_record = PriceForecast(
                    forecast_timestamp=row['timestamp'],
                    forecast_horizon_hours=1,  # Simplified for now
                    model_name=model_name,
                    predicted_value=row['predicted_price'],
                    confidence_level=0.95  # Default confidence level
                )
                session.add(forecast_record)
            
            session.commit()
            logger.info(f"Saved {len(forecasts)} forecasts to database")


def main():
    """Test the price estimator."""
    estimator = PriceEstimator()
    
    print("🔮 Romanian Energy Market Price Estimator")
    print("=" * 50)
    
    # Load and analyze historical data
    print("📊 Loading historical data...")
    data = estimator.load_historical_data(days_back=30)
    
    if data.empty:
        print("⚠️ No historical data available for analysis")
        return
    
    print(f"✅ Loaded {len(data)} records")
    
    # Calculate market statistics
    print("\n📈 Calculating market statistics...")
    stats = estimator.calculate_market_statistics()
    
    if 'volume_stats' in stats:
        vol_stats = stats['volume_stats']
        print(f"Volume Statistics:")
        print(f"  Mean: {vol_stats['mean']:.2f} MWh")
        print(f"  Range: {vol_stats['min']:.2f} - {vol_stats['max']:.2f} MWh")
        print(f"  Records: {vol_stats['count']}")
    
    if 'price_stats' in stats:
        price_stats = stats['price_stats']
        print(f"Price Statistics:")
        print(f"  Mean: {price_stats['mean']:.2f} EUR/MWh")
        print(f"  Range: {price_stats['min']:.2f} - {price_stats['max']:.2f} EUR/MWh")
        print(f"  Records: {price_stats['count']}")
    
    # Try to train models if we have price data
    if 'value_price' in data.columns and not data['value_price'].isna().all():
        print("\n🤖 Training prediction models...")
        feature_data = estimator.create_features(data)
        performance = estimator.train_models(feature_data)
        
        if performance:
            print("Model Performance:")
            for model_name, metrics in performance.items():
                print(f"  {model_name}: R² = {metrics['r2']:.3f}, RMSE = {metrics['rmse']:.2f}")
            
            # Generate forecasts
            print("\n🔮 Generating price forecasts...")
            forecasts = estimator.predict_prices(forecast_hours=6)
            
            if not forecasts.empty:
                print(f"Generated {len(forecasts)} forecasts")
                print("Sample forecasts:")
                for _, row in forecasts.head(3).iterrows():
                    print(f"  {row['timestamp']}: {row['predicted_price']:.2f} EUR/MWh")
        else:
            print("⚠️ Could not train models - insufficient data")
    else:
        print("⚠️ No price data available for model training")
    
    print("\n🎉 Price estimation analysis completed!")


if __name__ == "__main__":
    main()
