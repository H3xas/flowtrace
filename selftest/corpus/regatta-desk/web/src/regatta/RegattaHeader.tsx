import React, { Component } from 'react';
import { connect } from 'react-redux';
import { loadEntries, loadRegatta } from '../actions/regattas';

interface RegattaHeaderProps {
  regattaId: string;
  loadRegatta: (regattaId: string) => void;
  loadEntries: (regattaId: string) => void;
}

class RegattaHeader extends Component<RegattaHeaderProps> {
  componentDidMount() {
    this.props.loadRegatta(this.props.regattaId);
  }

  componentDidUpdate() {
    this.props.loadEntries(this.props.regattaId);
  }

  render() {
    return <header className="regatta-header">Regatta</header>;
  }
}

export default connect(null, { loadRegatta, loadEntries })(RegattaHeader);
