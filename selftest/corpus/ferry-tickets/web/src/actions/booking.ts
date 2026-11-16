import { httpClient } from '../http/httpClient';

export function placeOrder() {
  return httpClient.getGatewayClient().post('/api/v2/orders');
}

export function upperSeats() {
  return httpClient.getGatewayClient().get('/upper/seats');
}

export function carSeats() {
  return httpClient.getGatewayClient().get('/car/seats');
}

export function fareQuote() {
  return httpClient.getGatewayClient().get('/fares');
}
