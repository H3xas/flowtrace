import React from 'react';

export class Mooring extends React.Component {
  render() {
    return (
      <div>
        {this.props.showRope && <span>rope</span>}
        {this.state.coiled && <span>coiled</span>}
      </div>
    );
  }
}
