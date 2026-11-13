const request = (method: string, url: string) => fetch(url, { method }).then((response) => response.json());

const gateway = {
  get: (url: string) => request('GET', url),
};

export const httpClient = {
  getGatewayClient: () => gateway,
};
