import React from 'react';
import { connect } from 'react-redux';
import { loadGuideLogs } from '../actions/logs';

function GuideLogsPanel({ logs, onLoad }: GuideLogsPanelProps) {
  return (
    <section>
      <button onClick={onLoad}>Load</button>
      <ul>{logs.length}</ul>
    </section>
  );
}

export default connect(null, { onLoad: loadGuideLogs })(GuideLogsPanel);
