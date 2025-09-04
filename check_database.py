from src.data.models import ImbalancePrice, get_session
from datetime import datetime, timedelta

# Check what data we have for today
today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
tomorrow = today + timedelta(days=1)

with get_session() as session:
    # Get today's price data
    today_prices = session.query(ImbalancePrice).filter(
        ImbalancePrice.timestamp >= today,
        ImbalancePrice.timestamp < tomorrow
    ).order_by(ImbalancePrice.timestamp.desc()).limit(10).all()
    
    print('Current data in database for today:')
    if today_prices:
        for price in today_prices:
            print(f'  {price.timestamp.strftime("%Y-%m-%d %H:%M:%S")} - Price: {price.value}')
    else:
        print('  No price data for today')
    
    # Check the latest data we have
    latest_price = session.query(ImbalancePrice).order_by(ImbalancePrice.timestamp.desc()).first()
    if latest_price:
        print(f'\nLatest price data: {latest_price.timestamp.strftime("%Y-%m-%d %H:%M:%S")} - Price: {latest_price.value}')
    
    # Look for the 1.58 value specifically
    price_158 = session.query(ImbalancePrice).filter(ImbalancePrice.value == 1.58).first()
    if price_158:
        print(f'\nFound 1.58 value at: {price_158.timestamp.strftime("%Y-%m-%d %H:%M:%S")}')
    else:
        print('\n1.58 value not found in database')
        
    # Check for data around 14:15 and 17:15 today
    time_1415 = today.replace(hour=14, minute=15)
    time_1715 = today.replace(hour=17, minute=15)
    
    price_1415 = session.query(ImbalancePrice).filter(ImbalancePrice.timestamp == time_1415).first()
    price_1715 = session.query(ImbalancePrice).filter(ImbalancePrice.timestamp == time_1715).first()
    
    if price_1415:
        print(f'\nPrice at 14:15: {price_1415.value}')
    if price_1715:
        print(f'Price at 17:15: {price_1715.value}')
        
    # Show all data for today with times around 14:00-18:00
    afternoon_prices = session.query(ImbalancePrice).filter(
        ImbalancePrice.timestamp >= today.replace(hour=14),
        ImbalancePrice.timestamp <= today.replace(hour=18)
    ).order_by(ImbalancePrice.timestamp).all()
    
    print(f'\nAfternoon data (14:00-18:00) for today:')
    for price in afternoon_prices:
        print(f'  {price.timestamp.strftime("%Y-%m-%d %H:%M:%S")} - Price: {price.value}')
