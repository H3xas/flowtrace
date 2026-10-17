import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';
import { showNotice } from './notices';

export const WATCHERS_LOADED = 'watchers/loaded';
export const REPORT_LOADED = 'watchers/report-loaded';

export function loadWatchers(zoneId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(`/greenhouse/v1/zones/${zoneId}/watchers`)
      .then((growers) => dispatch({ type: WATCHERS_LOADED, growers }));
}

export function saveWatchers(zoneId: string, growerIds: string[]) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().put(`/greenhouse/v1/zones/${zoneId}/watchers`, { growerIds })
      .then((response) => {
        if (!response.stored) {
          dispatch(showNotice('watchers-unconfirmed'));
          return;
        }

        dispatch(showNotice('watchers-saved'));
      })
      .catch(() => dispatch(showNotice('watchers-failed')));
}

export function loadReport(url: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(url)
      .then((report) => dispatch({ type: REPORT_LOADED, report }));
}
