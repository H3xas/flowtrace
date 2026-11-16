import { Dispatch } from 'redux';
import { httpClient } from '../http/httpClient';
import { loadZoneReadings } from './zoneReadings';

export const PRIMARY_ZONE_LOADED = 'primaryZone/loaded';

export function loadPrimaryZone(growerId: string) {
  return (dispatch: Dispatch) =>
    httpClient.getGatewayClient().get(`/greenhouse/v1/zones/${growerId}/watchers`)
      .then((growers) => {
        dispatch({ type: PRIMARY_ZONE_LOADED, growers });
        if (growers.length > 0) {
          dispatch(loadZoneReadings(growers[0].id));
        }
      });
}
