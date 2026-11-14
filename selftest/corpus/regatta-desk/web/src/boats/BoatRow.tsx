import React from 'react';
import { connect } from 'react-redux';
import { inspectBoat, loadBoats } from '../actions/boats';

interface BoatRowProps {
  boatId: string;
  inspectBoat: (boatId: string) => void;
  loadBoats: () => void;
}

function BoatRow(props: BoatRowProps) {
  return (
    <li className="boat-row">
      <button type="button" onClick={() => props.inspectBoat(props.boatId)}>
        Inspect
      </button>
      <button
        type="button"
        onClick={() =>
          props.loadBoats()
        }
      >
        Reload
      </button>
    </li>
  );
}

export default connect(null, { inspectBoat, loadBoats })(BoatRow);
