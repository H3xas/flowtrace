import React, { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import PartnerDirectory from './PartnerDirectory';

const LedgerPage = lazy(() => import('./PartnerLedger'));

export default function PartnerRoutes() {
  return (
    <Routes>
      <Route path="partners" element={<PartnerDirectory />} />
      <Route
        path="ledger"
        element={
          <Suspense fallback={null}>
            <LedgerPage />
          </Suspense>
        }
      />
    </Routes>
  );
}
