import React from 'react';

export function Pier({ childFlag, spare }) {
  if (!spare) return null;
  return childFlag && (<span>lit</span>);
}
