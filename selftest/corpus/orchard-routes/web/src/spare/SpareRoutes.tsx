import React from 'react';
import { Route, Routes } from 'react-router-dom';
import SpareShelf from './SpareShelf';

const shelfEntries = [
  { path: '/shelf', component: <SpareShelf /> },
];

const entries = shelfEntries.concat([{ path: '/bench', component: <SpareShelf /> }]);

const ledgeEntries = [
  { path: '/ledge', component: <SpareShelf /> },
].concat([{ path: '/joist', component: <SpareShelf /> }]);

const postEntries = [
  { path: '/post', component: <SpareShelf /> }.path,
];

const sill = { path: '/sill', component: <SpareShelf /> }.entry;

const sillEntries = [
  { ...sill },
];

export function SpareRoutes() {
  return (
    <Routes>
      {entries.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
      {ledgeEntries.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
      {postEntries.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
      {sillEntries.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
    </Routes>
  );
}
