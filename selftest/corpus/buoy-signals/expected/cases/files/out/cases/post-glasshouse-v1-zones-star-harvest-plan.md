# POST glasshouse/v1/zones/*/harvest-plan

**Path:** HarvestPlanController.CommitPlan → HarvestPlanner.CommitPlan → AirflowInputs.Load → BrightnessInputs.Load → CarbonInputs.Load → DewPointInputs.Load → …

### U1  403 Forbidden  `#1580c88e`

**Title:** POST glasshouse/v1/zones/*/harvest-plan · reject · 403 Forbidden · context.Result → 403 Forbidden

**Preconditions:**
- RelayCheckFilter.OnAuthorizationAsync sets the filter result (reject taken)

**Steps:**
1. Authenticate as a user without the required permission.
2. Call `POST glasshouse/v1/zones/*/harvest-plan` with RelayCheckFilter.OnAuthorizationAsync sets the filter result, an existing id in the path.

**Expected:**
- 403 Forbidden

**Evidence today:** none

**Case id:** `TODO: pending`

### U2  db HarvestPlanRepository.InsertPlan · reads 12  `#3d18d80b`

**Title:** POST glasshouse/v1/zones/*/harvest-plan · effect · db HarvestPlanRepository.InsertPlan · happy path

**Preconditions:**
- none (happy path — no deciding branch)

**Steps:**
1. Authenticate as an authorised user.
2. Call `POST glasshouse/v1/zones/*/harvest-plan` with an existing id in the path.

**Expected:**
- db HarvestPlanRepository.InsertPlan

**Evidence today:** none

**Case id:** `TODO: pending`

---

2 cases · 0 fault cases · 2 uncovered
