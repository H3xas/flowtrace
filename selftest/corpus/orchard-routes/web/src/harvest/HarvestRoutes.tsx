import React, { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import CrateDetail from './crates/CrateDetail';

const CrateLedgerPage = lazy(() => import('./crates/CrateLedgerPage'));

export function HarvestRoutes() {
  return (
    <Routes>
      <Route
        path="crates"
        element={
          <Suspense fallback={null}>
            <CrateLedgerPage />
          </Suspense>
        }
      />
      <Route path="crates/:crateId" element={<CrateDetail />} />
    </Routes>
  );
}
