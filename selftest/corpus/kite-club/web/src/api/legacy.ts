import { httpClient } from '../http/httpClient';

export function legacyJoin(clubId: string) {
  return httpClient.getGatewayClient().post(`/clubs/v1/join/${clubId}`, {});
}
