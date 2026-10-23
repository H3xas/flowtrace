# GET glasshouse/v1/zones/*/readings

**Path:** ZoneReadingsController.GetReadings → ZoneReadingService.ListReadings

### U1  403 Forbidden  `#c288f95f`

**Title:** GET glasshouse/v1/zones/*/readings · reject · 403 Forbidden · context.Result → 403 Forbidden

**Preconditions:**
- RelayCheckFilter.OnAuthorizationAsync sets the filter result (reject taken)

**Steps:**
1. Authenticate as a user without the required permission.
2. Call `GET glasshouse/v1/zones/*/readings` with RelayCheckFilter.OnAuthorizationAsync sets the filter result, an existing id in the path.

**Expected:**
- 403 Forbidden

**Evidence today:** none

**Case id:** `TODO: pending`

### U2  reads 1  `#66026a0d`

**Title:** GET glasshouse/v1/zones/*/readings · effect · reads only · happy path

**Preconditions:**
- none (happy path — no deciding branch)

**Steps:**
1. Authenticate as an authorised user.
2. Call `GET glasshouse/v1/zones/*/readings` with an existing id in the path.

**Expected:**
- reads only (no observable write)

**Evidence today:** none

**Case id:** `TODO: pending`

---

2 cases · 0 fault cases · 2 uncovered
