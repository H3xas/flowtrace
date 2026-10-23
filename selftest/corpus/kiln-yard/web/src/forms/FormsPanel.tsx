import React from 'react';

export function FormsPanel({ rows, open }: FormsPanelProps) {
  const close = () => {
    if (open) rows.pop();
  };
  return (
    <div className="panel">
      <p>Delete? Are you sure && ready || not ?? later</p>
      {open && <span>open</span>}
      {rows.length > 0 ? <b>many</b> : <i>none?</i>}
      <button onClick={close} title={open ? 'Close' : 'Open'}>Close?</button>
    </div>
  );
}
