import React from 'react';
import { Pier } from './Pier';
import { Skiff } from './Skiff';

export function Deck({ flags, mode: m, nested: { inner }, loading, ready, boats, ...rest }) {
  if (loading) return null;
  if (!ready || m) {
    return <Empty />;
  }
  return (
    <div>
      {flags.flagA && <Pier childFlag={flags.flagA} />}
      {ready && (<Pier childFlag={ready} />)}
      {m ? <Pier childFlag={m} /> : <Empty />}
      {inner ? <Pier childFlag={inner} /> : null}
      {boats.map((boat) => <Pier key={boat.id} childFlag={boat.flags.flagA} />)}
      <Skiff {...rest} />
    </div>
  );
}

function Empty() {
  return <p>empty</p>;
}
