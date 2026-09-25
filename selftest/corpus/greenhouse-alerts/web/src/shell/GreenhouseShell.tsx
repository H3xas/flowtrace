import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { ZoneRoutes } from '../zones/ZoneRoutes';

export default function GreenhouseShell() {
  return (
    <main className="greenhouse-shell">
      <Routes>
        <Route path="zones/:zoneId/*" element={<ZoneRoutes />} />
      </Routes>
    </main>
  );
}
