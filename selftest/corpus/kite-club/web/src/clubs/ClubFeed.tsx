import React, { Component } from 'react';
import { connect } from 'react-redux';
import { joinClub } from '../actions/clubs';
import { Badge } from '../cards';
import JoinButton from './JoinButton';
import { Panel } from './Panel';

interface ClubFeedProps {
  clubId: string;
  joinClub: (clubId: string) => void;
}

class ClubFeed extends Component<ClubFeedProps> {
  handleJoin = () => {
    this.props.joinClub(this.props.clubId);
  };

  render() {
    return (
      <section className="club-feed">
        <button type="button" onClick={this.handleJoin}>
          Join
        </button>
        <JoinButton />
        <Panel />
        <JoinButton />
        <Badge />
      </section>
    );
  }
}

export default connect(null, { joinClub })(ClubFeed);
