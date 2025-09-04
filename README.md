# Romanian Energy Balancing Market Dashboard

A real-time dashboard for monitoring and analyzing Romanian energy balancing market data, including imbalance prices, volumes, and power generation statistics.

## Features

- **Real-time Data Collection**: Automatic collection of imbalance prices and volumes from ENTSO-E API
- **Power Generation Monitoring**: Live power generation data from Transelectrica
- **Interactive Dashboard**: Web-based dashboard with auto-refresh functionality
- **Historical Analysis**: Storage and analysis of historical market data
- **Price Forecasting**: Machine learning models for price prediction

## Live Demo

🌐 **[View Live Dashboard](https://romanian-energy-dashboard.onrender.com)**

## Architecture

- **Backend**: FastAPI with SQLAlchemy ORM
- **Database**: PostgreSQL (production) / SQLite (development)
- **Frontend**: HTML/CSS/JavaScript with real-time updates
- **Data Sources**: ENTSO-E API, Transelectrica API
- **Deployment**: Render.com with automatic deployments

## Local Development

### Prerequisites

- Python 3.11+
- Git

### Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd balancing
```

2. Create virtual environment:
```bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
```

3. Install dependencies:
```bash
pip install -r requirements.txt
```

4. Run the application:
```bash
python start_system.bat  # On Windows
# Or manually:
python src/web/app.py
```

5. Open your browser to `http://localhost:8000`

## Production Deployment

The application is configured for automatic deployment to Render.com:

### Environment Variables

- `RENDER`: Set to "true" for production
- `DATABASE_URL`: PostgreSQL connection string (auto-provided by Render)
- `ENTSOE_API_TOKEN`: ENTSO-E API token
- `PORT`: Application port (auto-provided by Render)

### Services

1. **Web Service**: FastAPI dashboard application
2. **Worker Service**: Background data collector
3. **Database**: PostgreSQL database

## API Endpoints

- `GET /` - Main dashboard
- `GET /api/market-data` - Market data API
- `GET /api/statistics` - Market statistics
- `GET /api/daily-intervals` - Daily interval data
- `GET /api/power-generation-intervals` - Power generation data
- `GET /health` - Health check

## Data Sources

- **ENTSO-E Transparency Platform**: Imbalance prices and volumes
- **Transelectrica**: Romanian power generation and consumption data

## Configuration

- `config.yaml` - Development configuration
- `config.prod.yaml` - Production configuration
- `render.yaml` - Render.com deployment configuration

## Database Schema

The application uses the following main tables:
- `imbalance_prices` - Price data
- `imbalance_volumes` - Volume data
- `net_imbalance_volumes` - Calculated net volumes
- `power_generation_data` - Power generation data
- `data_collection_logs` - Collection activity logs

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

This project is licensed under the MIT License.

## Support

For issues and questions, please create an issue in the GitHub repository.
