import React from 'react';
import { Route, Routes } from 'react-router-dom';
import AnnexLedger from './AnnexLedger';

const annexSection = '/annex-ledger';

const annexEntries = [
  { path: annexSection, component: <AnnexLedger /> },
];

export function AnnexRoutes() {
  return (
    <Routes>
      {annexEntries.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
    </Routes>
  );
}
