import React, { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';

const LedgerPage = lazy(() => import('./AuditLedger'));

export default function AuditRoutes() {
  return (
    <Routes>
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
