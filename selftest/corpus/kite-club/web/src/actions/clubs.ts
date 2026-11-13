import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const CLUB_JOINED = 'clubs/joined';

export function joinClub(clubId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().post(`/clubs/v1/join/${clubId}`, {})
      .then(() => dispatch({ type: CLUB_JOINED, clubId }));
}
