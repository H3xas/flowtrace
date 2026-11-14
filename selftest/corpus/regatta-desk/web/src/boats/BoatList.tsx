import React, { Component } from 'react';
import { connect } from 'react-redux';
import { pickBoat, removeBoat } from '../actions/boats';
import BoatRow from './BoatRow';

interface BoatListProps {
  pickBoat: (boatId: string) => void;
  removeBoat: (boatId: string) => void;
}

class BoatList extends Component<BoatListProps> {
  render() {
    return (
      <ul className="boat-list">
        <button type="button" onClick={() => this.props.pickBoat('b1')}>
          Pick
        </button>
        <button
          type="button"
          onClick={() => {
            this.props.removeBoat('b2');
          }}
        >
          Remove
        </button>
        <BoatRow boatId="b3" />
      </ul>
    );
  }
}

export default connect(null, { pickBoat, removeBoat })(BoatList);
