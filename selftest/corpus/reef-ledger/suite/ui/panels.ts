const PANEL_URLS = ['**/reef/v1/sites', '**/reef/v1/sites/closures'];

export async function stubEveryPanel(page) {
  for (const url of PANEL_URLS) {
    await page.route(url, (route) => route.fulfill({ json: [] }));
  }
}
