import React, { Component } from 'react';
import * as api from '../api';

class KeeperPanel extends Component<KeeperPanelProps> {
  confirm(form: PassageForm, user: Keeper, x: Passage) {
    if (form.valid) {
      if (user.signedIn) {
        api.save(x);
      }
    }
  }

  render() {
    return <button onClick={() => this.confirm(this.props.form, this.props.user, this.props.passage)}>Confirm</button>;
  }
}

export default KeeperPanel;
