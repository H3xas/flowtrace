import React from 'react';
import { Route, Routes } from 'react-router-dom';

export default function CellarLayout({ routes }: { routes: any[] }) {
  return (
    <Routes>
      {routes.map((entry) => (
        <Route path={entry.path} element={entry.component} key={entry.path} />
      ))}
    </Routes>
  );
}
