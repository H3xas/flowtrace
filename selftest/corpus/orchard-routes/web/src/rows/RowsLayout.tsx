import React from 'react';
import { Outlet } from 'react-router-dom';

export default function RowsLayout() {
  return (
    <section className="rows">
      <Outlet />
    </section>
  );
}
