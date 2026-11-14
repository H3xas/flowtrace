const request = (method: string, url: string) =>
  fetch(url, { method }).then((response) => (response.status === 204 ? null : response.json()));

const gateway = {
  get: (url: string) => request('GET', url),
};

export const httpClient = {
  getGatewayClient: () => gateway,
};
