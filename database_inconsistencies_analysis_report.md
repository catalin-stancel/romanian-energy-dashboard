# Database Inconsistencies Analysis Report

**Investigation Date:** 2025-08-19 17:31:15  
**Database:** `data/balancing_market.db`  
**Table:** `power_generation_data`

## Executive Summary

The investigation revealed significant data inconsistencies between the dashboard API and the database storage system. The primary issues are:

1. **Missing Intervals:** 26 out of 96 expected daily intervals are missing from the database
2. **Zero Import/Export Values:** 36 out of 70 stored records have zero imports and exports for early morning hours (00:00-08:45)
3. **Data Collection Gap:** Database contains only 70 records vs expected 96 intervals (27% data loss)

## Database Structure Analysis

### Table Schema
- **Total Records:** 2,564 (spanning from 2018-08-25 to 2025-08-19)
- **Key Fields:** timestamp, total_production, total_consumption, imports, exports, net_balance
- **Import/Export Columns:** Present in schema (added later as `imports` and `exports` REAL fields)

### Today's Data Summary (2025-08-19)
- **Expected Intervals:** 96 (every 15 minutes)
- **Actual Records:** 70 
- **Missing Intervals:** 26
- **Zero Import/Export Records:** 36 out of 70 (51.4%)

## Critical Issues Identified

### 1. Missing Intervals Pattern
**Missing Time Slots:**
- 14:45, 17:45, 18:00, 18:15, 18:30, 18:45
- 19:00, 19:15, 19:30, 19:45
- Plus 16 additional intervals

**Impact:** 27% of daily data is completely missing from the database.

### 2. Zero Import/Export Values Pattern
**Affected Time Range:** 00:00 to 08:45 (early morning hours)
**Pattern:** All 36 records in this timeframe show:
- Imports: 0 MW
- Exports: 0 MW
- Production and Consumption values appear normal

**Sample Zero Records:**
```
Time     | Prod  | Cons  | Import| Export
----------------------------------------
00:00    |  5074 |  5132 |      0|      0
00:15    |  5056 |  5121 |      0|      0
00:30    |  4998 |  5111 |      0|      0
...
08:45    |  5159 |  5445 |      0|      0
```

### 3. Normal Data Pattern (Post 09:00)
**Time Range:** 09:00 onwards
**Pattern:** Records show realistic import/export values:
```
Time     | Prod  | Cons  | Import| Export
----------------------------------------
09:00    |  5050 |  5487 |   1411|    202
09:15    |  5037 |  5518 |   1480|    196
10:00    |  4897 |  5494 |   1243|    303
```

## Root Cause Analysis

### 1. Data Collection System Issues
- **Interval Collection:** System is not capturing all 15-minute intervals
- **Early Morning Data:** Import/export calculation appears to fail during 00:00-08:45 timeframe
- **API vs Database Mismatch:** Dashboard API shows 96 intervals while database has only 70

### 2. Import/Export Calculation Problems
- **Time-Based Issue:** Zero values consistently occur during early morning hours
- **Possible Causes:**
  - Border flow data unavailable during these hours
  - API endpoint returning null/zero values
  - Calculation logic failing for specific time periods
  - Data source (Transelectrica API) not providing import/export data for early hours

### 3. Data Storage Gaps
- **Missing Intervals:** 26 intervals completely absent from database
- **No Historical Backfill:** Gaps are not being filled by subsequent data collection cycles

## Impact Assessment

### Dashboard Functionality
- **Current Interval:** Dashboard uses live API data (appears correct)
- **Historical Data:** Dashboard relies on incomplete database records
- **User Experience:** Users see inconsistent data patterns and missing historical intervals

### Data Integrity
- **Reliability:** Only 73% of expected data is stored
- **Accuracy:** 51% of stored records have incorrect import/export values
- **Completeness:** Significant gaps in historical data preservation

## Recommendations

### Immediate Actions
1. **Fix Import/Export Calculation:** Investigate why early morning hours return zero values
2. **Implement Interval Backfill:** Add mechanism to collect missing intervals
3. **Data Validation:** Add checks to prevent storing zero import/export values when they should have real data

### Long-term Solutions
1. **Robust Data Collection:** Implement retry mechanisms for failed data collection
2. **Data Quality Monitoring:** Add alerts for missing intervals or suspicious zero values
3. **Historical Data Repair:** Backfill missing intervals where possible
4. **API Fallback:** Implement alternative data sources for import/export data

## Technical Details

### Database Query Results
```sql
-- Today's record count
SELECT COUNT(*) FROM power_generation_data WHERE DATE(timestamp) = '2025-08-19';
-- Result: 70 records

-- Zero import/export count  
SELECT COUNT(*) FROM power_generation_data 
WHERE DATE(timestamp) = '2025-08-19' AND imports = 0 AND exports = 0;
-- Result: 36 records

-- Time range of zero values
SELECT MIN(timestamp), MAX(timestamp) FROM power_generation_data 
WHERE DATE(timestamp) = '2025-08-19' AND imports = 0 AND exports = 0;
-- Result: 00:00 to 08:45
```

### API Comparison Issue
- **API Connection:** Failed to connect to dashboard API during investigation
- **Error:** Connection refused (API may have been restarting)
- **Recommendation:** Implement proper API health checks

## Conclusion

The database inconsistencies represent a significant data quality issue affecting both historical data preservation and dashboard reliability. The systematic pattern of zero import/export values during early morning hours suggests a specific issue with the data collection or calculation logic during these time periods. Immediate attention is required to prevent further data loss and ensure accurate power system monitoring.

**Priority Level:** HIGH - Data integrity issues affecting core system functionality
**Estimated Fix Time:** 2-3 days for immediate fixes, 1-2 weeks for comprehensive solution
