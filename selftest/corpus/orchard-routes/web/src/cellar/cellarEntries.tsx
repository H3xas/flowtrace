import React from 'react';
import { CellarDefaults } from './CellarDefaults';
import CaskShelf from './CaskShelf';
import RackList from './RackList';

const cellarEntries = [
  { ...CellarDefaults, path: '/rack', component: <RackList /> },
  { path: '/casks', title: 'Casks', component: <CaskShelf /> },
];

export default cellarEntries;
