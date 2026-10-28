import React from 'react';
import { connect } from 'react-redux';
import { loadFirings } from '../actions/firings';

function KilnPanel({ kilnId, firings, onLoad }: KilnPanelProps) {
  const refresh = () => {
    if (kilnId) onLoad(kilnId);
  };
  return (
    <section>
      <button onClick={refresh}>Load?</button>
      {firings.length > 0 ? <ul>{firings.length}</ul> : <p>No firings && none planned</p>}
    </section>
  );
}

export default connect(null, { onLoad: loadFirings })(KilnPanel);
