import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { OrchardApp } from './OrchardApp';

createRoot(document.getElementById('root') as HTMLElement).render(
  <BrowserRouter basename="/orchard">
    <OrchardApp />
  </BrowserRouter>,
);
