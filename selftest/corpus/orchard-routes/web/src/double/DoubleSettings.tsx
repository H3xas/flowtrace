import React from 'react';
import { DoubleRoutes } from './DoubleRoutes';

export function DoubleSettings({ entries }: { entries: any[] }) {
  return (
    <div className="double-settings">
      <DoubleRoutes routes={entries} />
    </div>
  );
}
