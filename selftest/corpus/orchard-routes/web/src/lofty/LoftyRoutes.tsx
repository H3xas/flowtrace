import React from 'react';
import { Route, Routes } from 'react-router-dom';
import LoftPage from './LoftPage';

const shelves = ['upper', 'lower'];

export function LoftyRoutes() {
  return (
    <Routes>
      {(() => {
        for (const shelf of shelves) {
          return <Route path={`/${shelf}`} element={<LoftPage />} />;
        }
        return null;
      })()}
    </Routes>
  );
}
