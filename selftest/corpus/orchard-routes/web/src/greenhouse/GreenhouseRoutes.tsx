import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { features } from '../features';
import ColdFrameList from './ColdFrameList';
import GlassHousePage from './GlassHousePage';

export function GreenhouseRoutes() {
  const glasshouseRoute = () => {
    if (features.greenhouse) {
      return <Route path="/glasshouse" element={<GlassHousePage />} />;
    }
    return null;
  };

  return (
    <Routes>
      {glasshouseRoute()}
      <Route path="coldframes" element={<ColdFrameList />} />
    </Routes>
  );
}
