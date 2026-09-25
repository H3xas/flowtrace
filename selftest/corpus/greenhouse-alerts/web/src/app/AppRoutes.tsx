import React from 'react';
import { Route, Routes } from 'react-router-dom';
import GreenhouseShell from '../shell/GreenhouseShell';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/greenhouse/*" element={<GreenhouseShell />} />
    </Routes>
  );
}
