import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const SETTINGS_LOADED = 'settings/loaded';

export function loadSettings() {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get('/lanterns/v1/settings')
      .then((settings) => dispatch({ type: SETTINGS_LOADED, settings }));
}
