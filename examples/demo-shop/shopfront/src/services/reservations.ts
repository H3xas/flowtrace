import { httpClient } from '../http/httpClient';

export const reserveStock = (productId: string, quantity: number) =>
  httpClient.getGatewayClient().post('stock/v1/reservations', { productId, quantity });
