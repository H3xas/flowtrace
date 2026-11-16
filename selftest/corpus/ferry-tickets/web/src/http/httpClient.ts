const request = (method: string, url: string) => fetch(url, { method }).then((response) => response.json());

const gateway = {
  get: (url: string) => request('GET', url),
  post: (url: string) => request('POST', url),
};

export const httpClient = {
  getGatewayClient: () => gateway,
};
