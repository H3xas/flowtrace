import React, { Component } from 'react';
import * as api from '../api';

class BargePanel extends Component<BargePanelProps> {
  dock(x: Passage, tide: Tide, crew: Crew) {
    if (tide.high) {
      this.berth(x);
    }
    if (crew.ready) {
      this.berth(x);
    }
  }

  berth(x: Passage) {
    if (x.moored) {
      api.save(x);
    }
  }

  render() {
    const { passage, tide, crew } = this.props;
    return <button onClick={() => this.dock(passage, tide, crew)}>Dock</button>;
  }
}

export default BargePanel;
