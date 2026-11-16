import React from 'react';
import { useSelector } from 'react-redux';
import { pickShoal } from './selectors';

export function Shoal({ items, mode }) {
  const picked = useSelector(pickShoal);
  let captured = false;
  items.forEach((it) => {
    captured = it.on;
  });
  const twin = mode;
  if (mode) {
    const twin = picked;
  }
  return (
    <div>
      {picked && <span>picked</span>}
      {captured && <span>captured</span>}
      {twin && <span>twin</span>}
      {mode || <span>fallback</span>}
    </div>
  );
}
