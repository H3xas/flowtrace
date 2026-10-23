import React, { Component } from 'react';
import { connect } from 'react-redux';
import { loadPlans } from '../actions/dispatchActions';
import { DispatchItem, DispatchState } from './dispatchState';

interface DispatchBoardProps {
  items: DispatchItem[];
  loadPlans: () => void;
}

class DispatchBoard extends Component<DispatchBoardProps> {
  componentDidMount() {
    this.props.loadPlans();
  }

  render() {
    const { items = [] } = this.props;
    return (
      <section className="dispatch-board">
        <ul>
          {items.map((item) => (
            <li key={item.serial}>{item.origin}</li>
          ))}
        </ul>
      </section>
    );
  }
}

const mapState = (state: DispatchState) => ({ items: state.plans.items });

export default connect(mapState, { loadPlans })(DispatchBoard);
