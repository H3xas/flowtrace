const request = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then((response) => response.json());

const gateway = {
  get: (url: string) => request('GET', url),
  post: (url: string, body: unknown) => request('POST', url, body),
};

export const httpClient = {
  getGatewayClient: () => gateway,
};
