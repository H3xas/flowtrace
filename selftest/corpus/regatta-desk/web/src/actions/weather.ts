import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';

export const WIND_LOADED = 'weather/wind';

export const loadWind = () => (dispatch: Dispatch) =>
  httpClient.getGatewayClient().get('/weather/v1/wind').then((wind) => dispatch({ type: WIND_LOADED, wind }));

export const loadTide = (spot: string) => (dispatch: Dispatch) => {
  return httpClient.getGatewayClient().get('/weather/v1/tide').then((tide) => dispatch({ type: WIND_LOADED, spot, tide }));
};
