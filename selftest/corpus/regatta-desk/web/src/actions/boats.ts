import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export function loadBoats() {
  return () => httpClient.getGatewayClient().get('/boats/v1/all');
}

export function pickBoat(boatId: string) {
  return () => httpClient.getGatewayClient().post(`/boats/v1/${boatId}/pick`, {});
}

export function removeBoat(boatId: string) {
  return () => httpClient.getGatewayClient().delete(`/boats/v1/${boatId}`);
}

export function inspectBoat(boatId: string) {
  return () => httpClient.getGatewayClient().post(`/boats/v1/${boatId}/inspect`, {});
}
