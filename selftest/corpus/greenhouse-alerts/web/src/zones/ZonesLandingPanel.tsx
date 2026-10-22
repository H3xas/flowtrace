import React, { Component } from 'react';
import { connect } from 'react-redux';
import { loadPrimaryZone } from '../actions/primaryZone';
import { GreenhouseState, ZoneReading } from '../state/greenhouseState';

interface ZonesLandingPanelProps {
  growerId?: string;
  readings: ZoneReading[];
  loadPrimaryZone: (growerId: string) => void;
}

class ZonesLandingPanel extends Component<ZonesLandingPanelProps> {
  componentDidMount() {
    if (this.props.growerId) {
      this.props.loadPrimaryZone(this.props.growerId);
    }
  }

  render() {
    return (
      <section className="zones-landing">
        <p>{this.props.readings.length} readings</p>
      </section>
    );
  }
}

const mapState = (state: GreenhouseState) => ({ readings: state.zoneReadings.items });

export default connect(mapState, { loadPrimaryZone })(ZonesLandingPanel);
