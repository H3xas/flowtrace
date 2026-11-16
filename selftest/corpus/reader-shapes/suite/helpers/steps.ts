import { KilnClient } from '../clients/kiln-client';

export async function openStudio(request) {
  return request.put('studio/v1/doors/open');
}

export const coolDown = async (client: KilnClient) => {
  await client.list();
};

export async function stubKilns(page) {
  await page.route('**/studio/v1/kilns/**', (route) => route.fulfill({ json: [] }));
}

export async function watchGlazes(page) {
  await page.route('**/studio/v1/glazes/**', (route) => route.continue());
}
