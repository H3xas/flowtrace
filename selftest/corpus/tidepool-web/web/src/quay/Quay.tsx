import React from 'react';

export function Quay(props) {
  const { gate: { latch }, tide: level } = props;
  return (
    <div>
      {latch && <span>latch</span>}
      {level ? <span>level</span> : null}
    </div>
  );
}
