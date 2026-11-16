import React, { Component } from 'react';
import { connect } from 'react-redux';
import { acknowledgeAlarm, loadZoneReadings } from '../actions/zoneReadings';
import { GreenhouseState, ZoneReading } from '../state/greenhouseState';

interface ZoneOverviewPanelProps {
  zoneId?: string;
  readings: ZoneReading[];
  loadZoneReadings: (zoneId: string) => void;
  acknowledgeAlarm: (zoneId: string) => void;
  navigate: (path: string) => void;
}

class ZoneOverviewPanel extends Component<ZoneOverviewPanelProps> {
  componentDidMount() {
    if (this.props.zoneId) {
      this.props.loadZoneReadings(this.props.zoneId);
    }
  }

  openWatchers = () => {
    this.props.navigate(`/greenhouse/zones/${this.props.zoneId}/alerts/watchers`);
  };

  render() {
    const { zoneId = '', readings } = this.props;
    return (
      <section className="zone-overview">
        <ul>
          {readings.map((reading) => (
            <li key={reading.sensor}>{reading.value}</li>
          ))}
        </ul>
        <button type="button" onClick={() => this.props.acknowledgeAlarm(zoneId)}>
          Acknowledge alarm
        </button>
        <button type="button" onClick={this.openWatchers}>
          Alert watchers
        </button>
      </section>
    );
  }
}

const mapState = (state: GreenhouseState) => ({ readings: state.zoneReadings.items });

export default connect(mapState, { loadZoneReadings, acknowledgeAlarm })(ZoneOverviewPanel);
