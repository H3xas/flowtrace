import React, { Component } from 'react';
import { connect } from 'react-redux';
import { refreshAll } from '../actions/regattas';
import RegattaHeader from './RegattaHeader';

interface RegattaPageProps {
  regattaId: string;
  refreshAll: (regattaId: string) => void;
}

class RegattaPage extends Component<RegattaPageProps> {
  handleRefresh = () => {
    this.props.refreshAll(this.props.regattaId);
  };

  render() {
    return (
      <article className="regatta-page">
        <RegattaHeader regattaId={this.props.regattaId} />
        <button type="button" onClick={this.handleRefresh}>
          Refresh
        </button>
      </article>
    );
  }
}

export default connect(null, { refreshAll })(RegattaPage);
