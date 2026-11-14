import { httpClient } from '../http/httpClient';

export function loadGroup(groupId: string) {
  return () => httpClient.getGatewayClient().get(`/groups/v1/${groupId}`);
}
