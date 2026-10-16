import React from 'react';
import { Route, Routes } from 'react-router-dom';
import QueueHead from './QueueHead';
import QueuePane from './QueuePane';

const queues = [
  { path: '/head', title: 'Queue', component: <QueueHead /> },
  { path: '/:queueId', title: 'Pane', component: <QueuePane /> },
];

export function QueueRoutes() {
  return (
    <Routes>
      {queues.map((queue) => (
        <Route path={`${queue.path}/*`} element={<queue.component />} key={queue.path} />
      ))}
    </Routes>
  );
}
