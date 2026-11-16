import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export function roundMark(markId: string) {
  return () => httpClient.getGatewayClient().post(`/marks/v1/${markId}/round`, {});
}

export function skipMark(markId: string) {
  return () => httpClient.getGatewayClient().post(`/marks/v1/${markId}/skip`, {});
}

export function loadMark(markId: string) {
  return () => httpClient.getGatewayClient().get(`/marks/v1/${markId}`);
}
