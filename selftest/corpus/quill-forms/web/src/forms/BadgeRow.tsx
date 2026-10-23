import React from 'react';

function BadgeRow({ cond }: BadgeRowProps) {
  const open = cond ? <Badge
    x="1"
  /> : null;
  const shut = cond && <Badge
    y="2"
  />;
  const wrapped = cond ? (
    <Badge x="1" />
  ) : null;
  const joined = cond && (
    <Badge y="2" />
  );
  return <div>{open}{shut}{wrapped}{joined}</div>;
}

export default BadgeRow;
