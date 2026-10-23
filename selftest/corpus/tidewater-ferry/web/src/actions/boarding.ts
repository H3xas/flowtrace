import { Dispatch } from 'redux';
import { useEffect } from 'react';
import { httpClient } from '../http/httpClient';
import { noticeShown } from './notices';

export const BOARDING_LOADED = 'boarding/loaded';

export function loadRoute(routeId: string) {
  return httpClient.getGatewayClient().get(`/tidewater/v1/routes/${routeId}`);
}

export async function loadBoarding(ferryId: string, permit: boolean, routes: string[]) {
  const identity = await httpClient.getGatewayClient().get(`/tidewater/v1/ferries/${ferryId}/identity`);
  const route = await httpClient.getGatewayClient().get(`/tidewater/v1/ferries/${ferryId}/route`);
  if (permit) {
    await httpClient.getGatewayClient().post(`/tidewater/v1/ferries/${ferryId}/permits`, {});
  } else {
    noticeShown('permit-skipped');
  }
  for (const routeId of routes) {
    await httpClient.getGatewayClient().get(`/tidewater/v1/routes/${routeId}`);
  }
  return [identity, route];
}

export function loadAll(ferryId: string, routes: string[]) {
  return (dispatch: Dispatch) =>
    Promise.all(routes.map((routeId) => loadRoute(routeId))).then((loaded) => {
      dispatch({ type: BOARDING_LOADED, loaded });
    });
}

export function loadSettled(ferryId: string, routes: string[]) {
  return (dispatch: Dispatch) =>
    Promise.allSettled([loadRoute(routes[0]), loadRoute(routes[1])]).then((settled) => {
      dispatch({ type: BOARDING_LOADED, settled });
    });
}

export function loadFirst(ferryId: string, routes: string[]) {
  return Promise.race([loadRoute(routes[0]), loadRoute(routes[1])]);
}

export function loadWithFallback(ferryId: string) {
  return httpClient.getGatewayClient().get(`/tidewater/v1/ferries/${ferryId}/identity`)
    .then((identity) => noticeShown(identity.name))
    .catch(() => noticeShown('identity-failed'));
}

export async function loadNestedBoarding(permit: boolean, routes: string[]) {
  noticeShown('loading');
  if (permit) {
    for (const routeId of routes) {
      await httpClient.getGatewayClient().get(`/tidewater/v1/routes/${routeId}`);
    }
  }
}

export async function loadGuardedAll(permit: boolean, routes: string[]) {
  if (permit) {
    await Promise.all([loadRoute(routes[0]), loadRoute(routes[1])]);
  }
  noticeShown('guarded-all');
}

export async function loadLoopedAll(pairs: string[][]) {
  for (const pair of pairs) {
    await Promise.all([loadRoute(pair[0]), loadRoute(pair[1])]);
  }
  noticeShown('looped-all');
}

export async function loadTrySettled(routes: string[]) {
  try {
    await Promise.allSettled([loadRoute(routes[0]), loadRoute(routes[1])]);
  } catch (error) {
    noticeShown('settled-failed');
  }
}

export function watchBoarding(ferryId: string) {
  useEffect(async () => {
    await httpClient.getGatewayClient().get(`/tidewater/v1/ferries/${ferryId}/route`);
    noticeShown('watching');
  });
  return ferryId;
}

export function scheduleBoarding(ferryId: string) {
  scheduleLater(() => httpClient.getGatewayClient().get(`/tidewater/v1/ferries/${ferryId}/identity`));
}

function scheduleLater(work: () => unknown) {
  setTimeout(work, 0);
}
