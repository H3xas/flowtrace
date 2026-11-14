import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const LOGS_LOADED = 'logs/loaded';

export function loadGuideLogs() {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get('/reef/v1/divers/guide-7/logs')
      .then((items) => dispatch({ type: LOGS_LOADED, items }));
}
