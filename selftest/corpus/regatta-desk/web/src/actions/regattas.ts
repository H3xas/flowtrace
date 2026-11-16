import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const REGATTA_LOADED = 'regattas/loaded';

export function loadRegatta(regattaId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(`/regattas/v1/${regattaId}`)
      .then((regatta) => dispatch({ type: REGATTA_LOADED, regatta }));
}

export function loadEntries(regattaId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(`/regattas/v1/${regattaId}/entries`)
      .then((entries) => dispatch({ type: REGATTA_LOADED, entries }));
}

export function fileProtest(regattaId: string) {
  return () => httpClient.getGatewayClient().post(`/regattas/v1/${regattaId}/protests`, {});
}

export function loadResults() {
  return () => httpClient.getGatewayClient().get('/regattas/v1/results');
}

export function loadStandings(regattaId: string) {
  return () => httpClient.getGatewayClient().get(`/regattas/v1/${regattaId}/standings`);
}

export function refreshDesk(regattaId: string) {
  return (dispatch: any) => {
    dispatch(loadRegatta(regattaId));
    return dispatch(loadEntries(regattaId));
  };
}

export const refreshResults = (regattaId: string) => (dispatch: any) => {
  dispatch(loadResults());
  dispatch(loadStandings(regattaId));
};

export function refreshAll(regattaId: string) {
  return (dispatch: any) => {
    dispatch(refreshDesk(regattaId));
  };
}
