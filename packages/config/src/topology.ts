// Fixed loopback topology for the pilot. The web proxy and the worker reach the
// API only at this address; no upstream is ever derived from request input.
// This module holds no secrets, so browser-adjacent web code may import it.

export const WEB_HOST = '127.0.0.1';
export const WEB_PORT = 3105;

export const API_HOST = '127.0.0.1';
export const API_PORT = 4105;
export const API_ORIGIN = `http://${API_HOST}:${API_PORT}`;
