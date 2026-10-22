import React from 'react';
import { Route, Routes } from 'react-router-dom';
import storehouseRoutes from './routes';

export function StorehouseRoutes() {
  return (
    <Routes>
      {storehouseRoutes.map((route) => (
        <Route path={`${route.path}/*`} element={<route.component />} key={route.path} />
      ))}
    </Routes>
  );
}
