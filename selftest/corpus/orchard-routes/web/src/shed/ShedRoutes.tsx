import React from 'react';
import { useRoutes } from 'react-router-dom';
import ToolRack from './ToolRack';

export function ShedRoutes() {
  return useRoutes([{ path: 'tools', element: <ToolRack /> }]);
}
