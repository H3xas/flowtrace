import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';
import { DispatchState } from '../dispatch/dispatchState';

export const PLANS_LOADED = 'dispatch/plans-loaded';

const buildDispatchUrl = (bucket: string) => `/dispatch/v1/${bucket}/archive`;

export function loadPlans() {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().post('/dispatch/v1/' + buildDispatchUrl('plans'), {})
      .then((items) => dispatch({ type: PLANS_LOADED, items }));
}
