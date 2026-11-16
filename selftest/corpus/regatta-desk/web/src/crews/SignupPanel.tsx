import React, { Component } from 'react';
import { connect } from 'react-redux';
import { loadSignups, releaseCrew } from '../actions/crews';
import { ActionButton } from '../layout/ActionButton';

interface SignupPanelProps {
  crewId: string;
  loadSignups: () => void;
  releaseCrew: (crewId: string) => void;
}

class SignupPanel extends Component<SignupPanelProps> {
  render() {
    this.props.loadSignups();
    let action = () => {};
    if (this.props.crewId) {
      action = () => {
        this.props.releaseCrew(this.props.crewId);
      };
    }
    return <ActionButton label="Release" action={action} />;
  }
}

export default connect(null, { loadSignups, releaseCrew })(SignupPanel);
