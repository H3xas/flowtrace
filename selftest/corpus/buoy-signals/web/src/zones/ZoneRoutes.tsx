import React, { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import ZoneOverviewPanel from './ZoneOverviewPanel';

const WatcherPreferencesPage = lazy(() => import('./alerts/WatcherPreferencesPage'));

export function ZoneRoutes() {
  return (
    <Routes>
      <Route path="overview" element={<ZoneOverviewPanel />} />
      <Route
        path="alerts/watchers"
        element={
          <Suspense fallback={null}>
            <WatcherPreferencesPage />
          </Suspense>
        }
      />
    </Routes>
  );
}
