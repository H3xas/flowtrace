import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const FIRINGS_LOADED = 'firings/loaded';

export function loadFirings(kilnId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(`/kiln/v1/kilns/${kilnId}/firings`)
      .then((items) => dispatch({ type: FIRINGS_LOADED, items }));
}
