import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export function loadCrew(crewId: string) {
  return () => httpClient.getGatewayClient().get(`/crews/v1/${crewId}`);
}

export function signUpCrew(crewId: string) {
  return () => httpClient.getGatewayClient().post(`/crews/v1/${crewId}/signup`, {});
}

export function loadSignups() {
  return () => httpClient.getGatewayClient().get('/crews/v1/signups');
}

export function releaseCrew(crewId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().post(`/crews/v1/${crewId}/release`, {})
      .then(() => dispatch({ type: 'crews/released', crewId }));
}
