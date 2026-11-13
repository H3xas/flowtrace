import React, { Component } from 'react';
import { connect } from 'react-redux';
import { joinClub } from '../actions/clubs';

interface JoinButtonProps {
  joinClub: (clubId: string) => void;
}

class JoinButton extends Component<JoinButtonProps> {
  render() {
    return (
      <button type="button" onClick={this.props.joinClub}>
        Join now
      </button>
    );
  }
}

export default connect(null, { joinClub })(JoinButton);
