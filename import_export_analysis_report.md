# Import/Export Values Analysis Report

## Issue Summary
The user reported that import/export values in the dashboard appeared too low compared to expectations.

## Root Cause Analysis

### Initial Investigation
- **Dashboard showed**: ~300 MW imports
- **Expected**: Higher values based on the power generation units
- **Actual feed contained**: Much higher values when properly calculated

### Key Findings

1. **Unit Mapping was Correct**: All 19 specified units were properly mapped:
   - MUKA, ISPOZ, IS, UNGE, CIOA, GOTE, VULC, DOBR, VARN, KOZL1, KOZL2, DJER, SIP_, PANCEVO21, PANCEVO22, KIKI, SAND, BEKE1, BEKE115

2. **Feed Contains Additional "15" Suffix Units**: The Transelectrica feed includes both regular units and "15" versions:
   - KOZL2: 506 MW + KOZL215: 483 MW
   - DJER: 276 MW + DJER15: 299 MW  
   - MUKA: 188 MW + MUKA15: 177 MW
   - And others...

3. **User Restriction**: User confirmed to only use the original 19 units (no "15" suffixes)

## Current Values (Corrected)

### With Restricted 19-Unit List:
- **Total Imports**: 1377 MW
- **Total Exports**: 235 MW
- **Total Absolute**: 1612 MW

### Active Units Contributing:
**Imports (Positive Values):**
- KOZL2: 506 MW
- DJER: 276 MW
- MUKA: 188 MW
- BEKE1: 141 MW
- BEKE115: 135 MW
- SAND: 131 MW

**Exports (Negative Values):**
- DOBR: -72 MW
- VARN: -65 MW
- PANCEVO21: -66 MW
- VULC: -32 MW

**Inactive Units (Zero Values):**
- ISPOZ, IS, UNGE, CIOA, GOTE, KOZL1, PANCEVO22, KIKI, SIP_

## Solution Implemented

1. **Confirmed Unit Mapping**: Verified that only the specified 19 units are tracked
2. **Updated Database**: Forced data collection to update with current values
3. **Verified Calculation**: Confirmed imports/exports are calculated correctly:
   - Positive values → Imports
   - Negative values → Exports (converted to positive for display)

## Final Status

✅ **System is working correctly** with the restricted 19-unit list
✅ **Values are now accurate**: 1377 MW imports, 235 MW exports
✅ **Dashboard will show updated values** after next refresh cycle

## Note on "15" Suffix Units

The feed contains additional units with "15" suffixes that would add:
- Additional ~1255 MW imports
- Additional ~182 MW exports

These are **excluded** per user requirements to stick to the original 19-unit specification.
