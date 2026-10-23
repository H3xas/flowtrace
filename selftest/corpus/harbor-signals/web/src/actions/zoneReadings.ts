import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const READINGS_LOADED = 'zoneReadings/loaded';
export const ALARM_ACKNOWLEDGED = 'zoneReadings/alarm-acknowledged';

export function loadZoneReadings(zoneId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(`/greenhouse/v1/zones/${zoneId}/readings`)
      .then((items) => dispatch({ type: READINGS_LOADED, items }));
}

export function acknowledgeAlarm(zoneId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().post(`/greenhouse/v1/zones/${zoneId}/alarms/ack`, {})
      .then(() => dispatch({ type: ALARM_ACKNOWLEDGED, zoneId }));
}
