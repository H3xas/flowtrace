import React from 'react';
import { Outlet } from 'react-router-dom';

export function OrchardLayout() {
  return (
    <div className="orchard">
      <Outlet />
    </div>
  );
}
