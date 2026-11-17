import React, { Component } from 'react';
import * as api from '../api';

class HarborPanel extends Component<HarborPanelProps> {
  open(x: Passage) {
    if (this.props.ready) {
      this.store(x);
    }
  }

  close(x: Passage) {
    this.store(x);
  }

  store(x: Passage) {
    if (x.fresh) {
      api.save(x);
    }
  }

  sweep(first: boolean, second: boolean, x: Passage) {
    first || second && api.load(x.id);
  }

  render() {
    const { passage, first, second } = this.props;
    return (
      <section>
        <button onClick={() => this.open(passage)}>Open</button>
        <button onClick={() => this.close(passage)}>Close</button>
        <button onClick={() => this.sweep(first, second, passage)}>Sweep</button>
      </section>
    );
  }
}

export default HarborPanel;
