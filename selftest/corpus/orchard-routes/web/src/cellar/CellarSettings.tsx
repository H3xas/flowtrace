import React from 'react';
import cellarEntries from './cellarEntries';
import CellarLayout from './CellarLayout';

export default function CellarSettings() {
  return (
    <div className="cellar-settings">
      <CellarLayout routes={cellarEntries} />
    </div>
  );
}
