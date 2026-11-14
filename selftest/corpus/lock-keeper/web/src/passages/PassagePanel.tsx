import React, { Component } from 'react';
import * as api from '../api';

class PassagePanel extends Component<PassagePanelProps> {
  submit(form: PassageForm, x: Passage) {
    if (form.valid) {
      api.save(x);
    }
  }

  check(x: Passage) {
    if (api.load(x.id)) {
      x.seen = true;
    }
  }

  render() {
    const label = this.props.open ? 'Open' : 'Shut';
    return (
      <section>
        <button onClick={() => this.submit(this.props.form, this.props.passage)}>{label}</button>
        <button onClick={() => this.check(this.props.passage)}>Check</button>
      </section>
    );
  }
}

export default PassagePanel;
