import { httpClient } from './http/httpClient';

export function save(passage: unknown) {
  return httpClient.getGatewayClient().post('/lock/v1/passages', passage);
}

export function load(passageId: string) {
  return httpClient.getGatewayClient().get(`/lock/v1/passages/${passageId}`);
}
