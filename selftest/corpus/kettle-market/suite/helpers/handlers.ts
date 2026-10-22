import type { Route } from '@playwright/test';

export const importedHandler = async (route: Route) => {
  await route.fulfill({ status: 500 });
};
