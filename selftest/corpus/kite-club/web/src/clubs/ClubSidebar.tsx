import React from 'react';
import { connect } from 'react-redux';
import { joinClub } from '../actions/clubs';

interface ClubSidebarProps {
  clubId: string;
  joinClub: (clubId: string) => void;
}

function ClubSidebar(props: ClubSidebarProps) {
  props.joinClub(props.clubId);
  return <aside className="club-sidebar">Welcome</aside>;
}

export default connect(null, { joinClub })(ClubSidebar);
