import React from 'react';

export function PressingNav({ to, label }: { to: string; label: string }) {
  return <a className="pressing-nav" href={to}>{label}</a>;
}
