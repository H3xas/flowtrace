import React from 'react';
import { Route, Routes } from 'react-router-dom';
import SpareShelf from './SpareShelf';

const shelfEntries = [
  { path: '/shelf', component: <SpareShelf /> },
];

const entries = shelfEntries.concat([{ path: '/bench', component: <SpareShelf /> }]);

export function SpareRoutes() {
  return (
    <Routes>
      {entries.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
    </Routes>
  );
}
