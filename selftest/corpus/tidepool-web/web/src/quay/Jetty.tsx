import React from 'react';
import { Pier } from '../deck/Pier';

export function Jetty(props) {
  const open = props.harbor.open;
  if (open) return <Pier childFlag="on" spare />;
  return props.visible && (<span>jetty</span>);
}
